/**
 * `product` fiyat özeti (`min_price`, `max_price`, `offer_count`,
 * `in_stock_count`, `foreign_offer_count`) — TypeScript yazanları için. Ürün kartı
 * "N mağaza"yı ve fiyatı, bütçe süzgeci `min_price`'ı, alternatifler/görsel/link
 * arama `offer_count > 0`'ı, keşfet `in_stock_count > 0`'ı, site haritası
 * `offer_count`'u okur.
 *
 * Kural TEK yerde: veritabanı fonksiyonu `refresh_product_aggregates(bigint[])`
 * (migration 0086). Python (`services/ingest/db/product_aggregates.py`) aynı
 * fonksiyonu çağırır; iki dilde kopya SQL yoktur. Anlam (karar 0121, 0127):
 * fiyat ve mağaza sayıları yalnızca aktif mağazanın fiyatlı aktif TRY teklifi;
 * `foreign_offer_count` = fiyatlı aktif TRY DIŞI teklifi olan farklı mağaza; arama
 * uygunluğu `offer_count > 0 OR foreign_offer_count > 0`'dır (karar 0129).
 * Değişmeyen satır yazılmaz; tekrar çalıştırmak 0 satır günceller.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { withJobRun } from "../ops/job-run.ts";

type Executor = Pick<Database, "execute">;

/**
 * Tam onarımda ve mağaza aç/kapatta bir işlemin kapsadığı ürün sayısı: değişen
 * `product` satırları yalnızca parti boyunca kilitli kalır, toplama/eşleştirme
 * yazıcıları beklemez (Python `REFRESH_BATCH_SIZE` ile aynı).
 */
export const AGGREGATE_BATCH_SIZE = 1000;

export type AggregateScope = { productIds: readonly number[] };

/** Verilen ürünlerin özetini çağıranın işleminde yeniler; güncellenen satır sayısını döner. */
export async function refreshProductAggregates(
  db: Executor,
  scope: AggregateScope,
): Promise<number> {
  const ids = [...new Set(scope.productIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return 0;
  const result = await db.execute<{ updated: number }>(
    sql`SELECT refresh_product_aggregates(${sql.param(ids)}::bigint[]) AS updated`,
  );
  return Number(result.rows[0]?.updated ?? 0);
}

export interface BatchedRefreshOptions {
  /** Bu süreden sonra yeni parti başlatılmaz (ms); verilmezse hepsi işlenir. */
  budgetMs?: number;
  batchSize?: number;
  /** Test için saat. */
  now?: () => number;
}

export interface BatchedRefreshResult {
  updated: number;
  /** Süre bitti, kalan ürünler bu koşuda yenilenmedi (günlük onarım tamamlar). */
  pending: boolean;
}

/**
 * `ids` sorgusunun döndürdüğü ürünleri artan kimlikle partiler halinde, HER PARTİ
 * KENDİ İŞLEMİNDE yeniler. `ids(after, limit)` kimliği `after`dan büyük, artan
 * sıralı, en fazla `limit` ürün döner; boş liste = bitti (kısa liste bitti demek değil).
 */
async function refreshInBatches(
  db: Database,
  ids: (after: number, limit: number) => Promise<number[]>,
  { budgetMs, batchSize = AGGREGATE_BATCH_SIZE, now = Date.now }: BatchedRefreshOptions = {},
): Promise<BatchedRefreshResult> {
  const started = now();
  let updated = 0;
  let after = 0;
  for (;;) {
    if (budgetMs !== undefined && now() - started >= budgetMs) {
      return { updated, pending: true };
    }
    const batch = await ids(after, batchSize);
    if (batch.length === 0) break;
    updated += await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '50s'`);
      return refreshProductAggregates(tx, { productIds: batch });
    });
    after = batch[batch.length - 1] as number;
  }
  return { updated, pending: false };
}

function idList(rows: { id: unknown }[]): number[] {
  return rows.map((row) => Number(row.id));
}

/** Tüm YAYINLANMIŞ katalog (yayınlanmamış kaynak ilanları teklife bağlı değildir; karar 0121). */
export function refreshPublishedAggregates(
  db: Database,
  options: BatchedRefreshOptions = {},
): Promise<BatchedRefreshResult> {
  return refreshInBatches(
    db,
    async (after, limit) =>
      idList(
        (
          await db.execute<{ id: unknown }>(sql`
            SELECT id FROM product
             WHERE publication_state = 'published' AND id > ${after}
             ORDER BY id LIMIT ${limit}`)
        ).rows,
      ),
    options,
  );
}

/**
 * Mağazanın (pasif teklifleri dahil: aç/kapat onların ürünlerini de etkiler)
 * teklif verdiği ürünler.
 */
export function refreshMerchantAggregates(
  db: Database,
  merchantId: number,
  options: BatchedRefreshOptions = {},
): Promise<BatchedRefreshResult> {
  // `offer_merchant_state_idx (merchant_id, is_active, product_id)` aktif ve pasif
  // teklifleri AYRI ayri product_id sirasiyla verir; tek sorgu sirayi kuramaz ve her
  // partide magazanin tum tekliflerini okurdu. Birlesimin en kucuk `limit` kimligi
  // her iki listenin ilk `limit` elemaninin icindedir: birlestirip ilk `limit`i almak
  // hicbir urunu atlamaz.
  const side = async (active: boolean, after: number, limit: number) =>
    idList(
      (
        await db.execute<{ id: unknown }>(sql`
          SELECT DISTINCT product_id AS id FROM offer
           WHERE merchant_id = ${merchantId} AND is_active = ${active} AND product_id > ${after}
           ORDER BY product_id LIMIT ${limit}`)
      ).rows,
    );
  return refreshInBatches(
    db,
    async (after, limit) => {
      const merged = [...(await side(true, after, limit)), ...(await side(false, after, limit))];
      return [...new Set(merged)].sort((a, b) => a - b).slice(0, limit);
    },
    options,
  );
}

/** `job_run.job` ve yönetim iş listesi anahtarı (`KNOWN_JOBS`). */
export const PRODUCT_AGGREGATES_JOB = "product_aggregates";

/**
 * Günlük onarım (VPS cron, 23:45 UTC): olağan yenileme yazma işleminin içinde olur;
 * bu koşu atlanmış bir yolu (elle SQL, yeni bir yazan, süresi dolan mağaza
 * aç/kapat) bir gün içinde düzeltir. Tutarlıysa 0 satır yazar. Partiler kendi
 * işleminde kısa sürer; parti başına kilit beklemesi ve süre sınırlıdır, aşılırsa
 * koşu `failed` yazılır ve yalnızca o parti geri alınır.
 */
export async function runProductAggregateRepair(db: Database): Promise<{ updated: number }> {
  return withJobRun(db, PRODUCT_AGGREGATES_JOB, "cron", async () => ({
    updated: (await refreshPublishedAggregates(db)).updated,
  }));
}
