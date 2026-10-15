/**
 * Teklifin "son gorulme" zamani (karar 0114). Besleme senkronizasyonu degismeyen
 * offer satirini YENIDEN YAZMAZ (WAL/sisme olcumu); goruldugu bilgi dar uyelik
 * satirinda (`feed_source_offer.last_seen_at`) tutulur. Tazelik olcumleri ikisinin
 * buyugunu kullanir. `o` takma adli `offer` satiri bekler.
 */
import { type SQL, sql } from "drizzle-orm";

export const OFFER_SEEN_AT = sql`GREATEST(o.last_seen_at, (SELECT max(fo.last_seen_at) FROM feed_source_offer fo WHERE fo.offer_id = o.id))`;

/**
 * Toplu sayımlar için (milyonlarca satır): `OFFER_SEEN_AT` her teklif için ilişkili alt
 * sorgu çalıştırır (satır başına bir indeks araması; ifade birden çok kez geçerse o kadar
 * kez) ve zaman aşımına düşer. Bunun yerine üyelik tablosu tek geçişte `offer_id` başına
 * toplanır ve `o` ile birleştirilir. `FROM offer o` sonrasına `OFFER_SEEN_JOIN`, ifadeler
 * için `OFFER_SEEN_AT_JOINED` kullanılır; anlam `OFFER_SEEN_AT` ile aynıdır.
 */
export const OFFER_SEEN_JOIN = sql`LEFT JOIN (
  SELECT offer_id, max(last_seen_at) AS seen_at FROM feed_source_offer GROUP BY offer_id
) fs ON fs.offer_id = o.id`;
export const OFFER_SEEN_AT_JOINED = sql`GREATEST(o.last_seen_at, fs.seen_at)`;

/**
 * Tek satır filtresi için: önce ucuz `offer.last_seen_at` koşulu, üyelik tablosuna ancak
 * o geçerse bakılır. `GREATEST(a, b) < t` ⇔ `a < t AND b < t` (NULL yok sayılır).
 */
export function offerNotSeenSince(cutoff: SQL) {
  return sql`(o.last_seen_at < ${cutoff} AND NOT EXISTS (
    SELECT 1 FROM feed_source_offer fo WHERE fo.offer_id = o.id AND fo.last_seen_at >= ${cutoff}
  ))`;
}
