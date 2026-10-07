/**
 * `product` fiyat özeti (`min_price`, `max_price`, `offer_count`,
 * `in_stock_count`) — TypeScript yazanları için. Ürün kartı "N mağaza"yı ve
 * fiyatı, bütçe süzgeci `min_price`'ı, alternatifler/görsel/link arama
 * `offer_count > 0`'ı, keşfet `in_stock_count > 0`'ı, site haritası
 * `offer_count`'u okur.
 *
 * Anlam aramanın `best_offer` kuralıyla aynıdır: yalnızca AKTİF MAĞAZANIN
 * fiyatlı aktif teklifi sayılır. `offer_count` = böyle teklifi olan farklı
 * mağaza sayısı; `in_stock_count` = bunlardan stokta olan mağaza sayısı. Kolon
 * adları migration gerektirmesin diye korunur.
 *
 * Aynı SQL Python tarafında `services/ingest/db/product_aggregates.py`
 * içindedir (toplama/eşleştirme bunu çağıramaz); ikisi birlikte değişir.
 * Değişmeyen satır yazılmaz; tekrar çalıştırmak 0 satır günceller.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { withJobRun } from "../ops/job-run.ts";

type Executor = Pick<Database, "execute">;

export type AggregateScope =
  | { productIds: readonly number[] }
  | { merchantId: number }
  | { all: true };

function scopeCondition(scope: AggregateScope): SQL | null {
  if ("all" in scope) return sql`TRUE`;
  if ("merchantId" in scope) {
    // Mağazanın pasif teklifleri de: aç/kapat onların ürünlerini de etkiler.
    return sql`p2.id IN (SELECT so.product_id FROM offer so
                          WHERE so.merchant_id = ${scope.merchantId}
                            AND so.product_id IS NOT NULL)`;
  }
  const ids = [...new Set(scope.productIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return null;
  return sql`p2.id = ANY(${sql.param(ids)}::bigint[])`;
}

/** Kapsamdaki ürünlerin özetini yeniler; güncellenen satır sayısını döner. */
export async function refreshProductAggregates(
  db: Executor,
  scope: AggregateScope,
): Promise<number> {
  const condition = scopeCondition(scope);
  if (condition === null) return 0;
  const result = await db.execute(sql`
    UPDATE product p SET
        min_price        = agg.min_price,
        max_price        = agg.max_price,
        offer_count      = agg.offer_count,
        in_stock_count   = agg.in_stock_count,
        price_updated_at = now(),
        updated_at       = now()
    FROM (
        SELECT p2.id AS product_id,
               min(o.current_price)                                         AS min_price,
               max(o.current_price)                                         AS max_price,
               count(DISTINCT o.merchant_id)::int                           AS offer_count,
               count(DISTINCT o.merchant_id) FILTER (WHERE o.in_stock)::int AS in_stock_count
          FROM product p2
          LEFT JOIN (offer o JOIN merchant m ON m.id = o.merchant_id AND m.is_active)
            ON o.product_id = p2.id AND o.is_active AND o.current_price IS NOT NULL
         WHERE ${condition}
         GROUP BY p2.id
    ) agg
    WHERE p.id = agg.product_id
      AND (p.min_price, p.max_price, p.offer_count, p.in_stock_count)
          IS DISTINCT FROM (agg.min_price, agg.max_price, agg.offer_count, agg.in_stock_count)
  `);
  return result.rowCount ?? 0;
}

/** `job_run.job` ve yönetim iş listesi anahtarı (`KNOWN_JOBS`). */
export const PRODUCT_AGGREGATES_JOB = "product_aggregates";

/**
 * Günlük onarım (Vercel cron): olağan yenileme yazma işleminin içinde olur;
 * bu koşu atlanmış bir yolu (elle SQL, yeni bir yazan) bir gün içinde
 * düzeltir. Tutarlıysa 0 satır yazar. Toplama işini bekletmesin diye kilit
 * beklemesi ve süre sınırlıdır; aşılırsa koşu `failed` yazılır, veri değişmez.
 */
export async function runProductAggregateRepair(db: Database): Promise<{ updated: number }> {
  return withJobRun(db, PRODUCT_AGGREGATES_JOB, "cron", async () => ({
    updated: await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '50s'`);
      return refreshProductAggregates(tx, { all: true });
    }),
  }));
}
