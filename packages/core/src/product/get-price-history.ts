/**
 * docs/decisions/0019: architecture.md'nin "istek yolu fiyat gecmisini
 * asla taramaz" kuralina TEK istisna. Tek urune, 90 gune ve indekslere
 * (`offer_product_idx`, `price_point_offer_time_idx`) sinirli - EXPLAIN ile
 * dogrulanmis, hicbir sequential scan yok.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
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
  const result = await db.execute<RawRow>(sql`
    SELECT date_trunc('day', pp.observed_at)::date::text AS day, MIN(pp.price)::text AS min_price
    FROM price_point pp
    JOIN offer o ON o.id = pp.offer_id
    WHERE o.product_id = ${productId}
      AND pp.observed_at >= now() - (${days}::text || ' days')::interval
    GROUP BY 1
    ORDER BY 1
  `);

  return result.rows.map((row) => ({
    date: row.day,
    minPriceKurus: Number(row.min_price),
  }));
}
