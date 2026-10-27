/**
 * Teklif tazeliği (karar 0155): beslemede uzun süredir görülmeyen teklifin fiyatı
 * "güncel" gibi gösterilmez. Teklif silinmez, pasifleştirilmez, fiyat geçmişi
 * (`price_point`) ve `product_id` bağı değişmez; yalnızca OKUMA yolunda süzülür.
 *
 * Kural besleme başına ve AÇIKTIR (`feed_source.config.freshness`); politikası olmayan
 * besleme (ör. Hepsiburada toplayıcısı: taranan alt küme, günlük tam sürüm yok) hiç
 * etkilenmez. Üç kanıt birlikte aranır:
 *
 * 1. Teklif yaşı: üyeliğin son görülmesi `unverified_after_days`'ten eski.
 * 2. Başarılı sürüm geçmişi: teklifin son görüldüğü sürümden SONRA, teklifsiz tamamlanmış
 *    (`complete`) sürümler en az `min_absent_days` FARKLI UTC gününe yayılıyor (varsayılan 2).
 *    Kaynağın başarısız olduğu günlerde sürüm oluşmaz; o günler "teklif kayboldu" diye
 *    sayılmaz. Tek bir başarılı sürüm tek başına kayıp kanıtı değildir.
 * 3. Kaynak sağlığı (isteğe bağlı): `source_stale_after_days` içinde hiç başarılı sürüm
 *    yoksa fiyat doğrulanamaz; neden teklifin kendisi değil kaynaktır. Bu sınır tanımsızsa
 *    kaynak kesintisi teklifleri gizlemez. Politikalı besleme `disabled`/`gone` ise fiyat
 *    artık doğrulanamaz ve sınırdan bağımsız olarak teklifleri doğrulanamaz sayılır.
 *
 * Birden çok beslemede (fiyat bandı geçişi) üyelik varsa, herhangi bir politikalı üyelik
 * tazeyse teklif doğrulanmıştır.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";

/** `feed_source.config` altındaki politika nesnesi. */
export const FRESHNESS_CONFIG_KEY = "freshness";
/** Teklifsiz tamamlanmış sürümlerin en az kaç farklı UTC gününe yayılması gerektiği. */
export const DEFAULT_MIN_ABSENT_DAYS = 2;

export type UnverifiedReason = "offer_missing" | "source_stale";

const ALIAS = /^[a-z_][a-z0-9_]*$/;

function alias(name: string): SQL {
  if (!ALIAS.test(name)) throw new Error(`Gecersiz SQL takma adi: ${name}`);
  return sql.raw(name);
}

/**
 * `config.freshness.<alan>` yalnızca 1-3 haneli tamsayıysa okunur; bozuk değer (metin,
 * eksi, çok büyük) NULL olur, yani sorgu hata vermez ve politika yokmuş gibi davranır.
 */
function configInt(feed: string, field: string): SQL {
  const path = sql.raw(`${feed}.config #>> '{${FRESHNESS_CONFIG_KEY},${field}}'`);
  return sql`CASE WHEN ${path} ~ '^[0-9]{1,3}$' THEN (${path})::int END`;
}

/**
 * Teklif doğrulanmış mı (boolean SQL ifadesi; `WHERE` içinde kullanılır).
 * Politikalı bir üyeliği olmayan teklif her zaman doğrulanmıştır.
 *
 * Maliyet: teklif başına `feed_source_offer_offer_idx` ile birkaç satır + `feed_source`
 * birincil anahtarı + (yalnızca yaş eşiği aşılmışsa) ~on satırlık `source_snapshot`
 * taraması. Yalnızca sınırlı aday kümesine (arama adayları, tek ürün) uygulanır.
 */
export function offerVerifiedSql(offerAlias = "o"): SQL {
  const o = alias(offerAlias);
  return sql`COALESCE((
    SELECT bool_or(NOT z.stale)
      FROM (
        SELECT (
            y.status IN ('disabled', 'gone')
            OR (y.source_stale_days IS NOT NULL
                AND (y.last_success_at IS NULL
                     OR y.last_success_at < now() - make_interval(days => y.source_stale_days)))
            OR (y.last_seen_at < now() - make_interval(days => y.unverified_days)
                AND (SELECT count(DISTINCT (s.completed_at AT TIME ZONE 'UTC')::date)
                       FROM source_snapshot s
                      WHERE s.feed_source_id = y.feed_id AND s.status = 'complete'
                        AND s.id > y.last_snapshot_id) >= y.min_absent_days)
          ) AS stale
          FROM (
            SELECT f.id AS feed_id, f.status, f.last_success_at,
                   m.last_seen_at, m.last_snapshot_id,
                   NULLIF(${configInt("f", "unverified_after_days")}, 0) AS unverified_days,
                   GREATEST(COALESCE(${configInt("f", "min_absent_days")}, ${sql.raw(String(DEFAULT_MIN_ABSENT_DAYS))}), 1)
                     AS min_absent_days,
                   NULLIF(${configInt("f", "source_stale_after_days")}, 0) AS source_stale_days
              FROM feed_source_offer m
              JOIN feed_source f ON f.id = m.feed_source_id
             WHERE m.offer_id = ${o}.id
          ) y
         WHERE y.unverified_days IS NOT NULL
      ) z
  ), TRUE)`;
}

/**
 * Üründe en az bir etkin teklif doğrulanmamış mı. Eşleşen teklifi (`best_offer`) olmayan
 * ürünün, tüm teklifleri doğrulanmadığı için mi yoksa başka sebeple mi eşleşmesiz kaldığını
 * ayırmak için kullanılır: doğrulanmamış teklife dayanan ürün sonuç kartına "fiyatsız" olarak
 * girmez.
 */
export function productHasUnverifiedOfferSql(productAlias = "p"): SQL {
  const p = alias(productAlias);
  return sql`EXISTS (
    SELECT 1 FROM offer ux
     WHERE ux.product_id = ${p}.id AND ux.is_active AND NOT ${offerVerifiedSql("ux")}
  )`;
}

/**
 * Fiyatı doğrulanamayan ürünü sonuç kümesinde tutmamak için `LEFT JOIN best_offer bo`
 * kullanan sorguların eklediği koşul: eşleşen teklif varsa ya da ürünün doğrulanmamış teklifi
 * yoksa (eski davranış) ürün kalır.
 */
export function visibleWithoutBestOfferSql(productAlias = "p", bestOfferAlias = "bo"): SQL {
  const bo = alias(bestOfferAlias);
  return sql`(${bo}.product_id IS NOT NULL OR NOT ${productHasUnverifiedOfferSql(productAlias)})`;
}

export interface ProductUnverifiedOffers {
  /** Fiyatı olan, etkin, stokta, doğrulanamayan yurt dışı teklif sayısı. */
  count: number;
  /** Bu tekliflerin kaynakta en son GÖRÜLDÜĞÜ an; yoksa null. */
  lastConfirmedAt: Date | null;
}

type UnverifiedRow = { n: number | string; confirmed_at: string | null };

/**
 * Ürün sayfası: doğrulanmış yurt dışı teklif yokken "mağaza fiyatı yok" yerine nedenini
 * söylemek için. Fiyat DÖNDÜRÜLMEZ: doğrulanamayan fiyat gösterilmez (karar 0155).
 */
export async function getProductUnverifiedForeignOffers(
  db: Database,
  productId: number,
): Promise<ProductUnverifiedOffers> {
  const result = await db.execute<UnverifiedRow>(sql`
    SELECT count(*)::int AS n,
           max(COALESCE((SELECT max(fm.last_seen_at) FROM feed_source_offer fm
                          WHERE fm.offer_id = o.id), o.last_seen_at)) AS confirmed_at
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id AND m.is_active
     WHERE o.product_id = ${productId}
       AND o.is_active AND o.in_stock
       AND o.currency <> 'TRY'
       AND o.current_price IS NOT NULL AND o.current_price > 0
       AND NOT ${offerVerifiedSql("o")}
  `);
  const row = result.rows[0];
  return {
    count: Number(row?.n ?? 0),
    lastConfirmedAt: row?.confirmed_at ? new Date(row.confirmed_at) : null,
  };
}
