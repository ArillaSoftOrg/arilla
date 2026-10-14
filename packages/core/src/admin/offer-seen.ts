/**
 * Teklifin "son gorulme" zamani (karar 0114). Besleme senkronizasyonu degismeyen
 * offer satirini YENIDEN YAZMAZ (WAL/sisme olcumu); goruldugu bilgi dar uyelik
 * satirinda (`feed_source_offer.last_seen_at`) tutulur. Tazelik olcumleri ikisinin
 * buyugunu kullanir. `o` takma adli `offer` satiri bekler.
 */
import { sql } from "drizzle-orm";

export const OFFER_SEEN_AT = sql`GREATEST(o.last_seen_at, (SELECT max(fo.last_seen_at) FROM feed_source_offer fo WHERE fo.offer_id = o.id))`;
