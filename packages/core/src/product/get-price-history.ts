/**
 * docs/decisions/0019: architecture.md'nin "istek yolu fiyat gecmisini
 * asla taramaz" kuralina TEK istisna. Tek urune, 90 gune ve indekslere
 * (`offer_product_idx`, `price_point_offer_time_idx`) sinirli - EXPLAIN ile
 * dogrulanmis, hicbir sequential scan yok.
 *
 * `price_point` degisim olayidir (karar 0068): gunluk seri `offer-price-days.ts`
 * ile degisim olaylarindan ve `offer.last_seen_at`'ten turetilir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { offerPriceDaysSql } from "./offer-price-days.ts";
import type { PriceHistoryPoint } from "./result-types.ts";

type RawRow = Record<string, unknown> & {
  day: string;
  min_price: string;
};

export async function getPriceHistory(
  db: Database,
  productId: number,
  days = 90,
): Promise<PriceHistoryPoint[]> {
  // price_point yalnizca degisimde yazilir; gunluk seri degisim olaylarindan ve
  // offer.last_seen_at'ten turetilir (offer-price-days.ts, karar 0068).
  const result = await db.execute<RawRow>(sql`
    SELECT d.day, MIN(d.min_price::bigint)::text AS min_price
    FROM (${offerPriceDaysSql(sql`SELECT id FROM offer WHERE product_id = ${productId}`, days)}) d
    GROUP BY d.day
    ORDER BY d.day
  `);

  return result.rows.map((row) => ({
    date: row.day,
    minPriceKurus: Number(row.min_price),
  }));
}
