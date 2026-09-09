import { type Database, productPriceStats } from "@arilla/db";
import { eq } from "drizzle-orm";
import type { ProductPriceStatsDetail } from "./result-types.ts";

/** `product_price_stats` tek satirlik PK okumasi - B5'in gecelik isinin ciktisi. */
export async function getPriceStats(
  db: Database,
  productId: number,
): Promise<ProductPriceStatsDetail | null> {
  const rows = await db
    .select({
      min30d: productPriceStats.min30d,
      min90d: productPriceStats.min90d,
      max90d: productPriceStats.max90d,
      median90d: productPriceStats.median90d,
      currentPercentile: productPriceStats.currentPercentile,
      dropCount90d: productPriceStats.dropCount90d,
      listPriceInflated: productPriceStats.listPriceInflated,
      listPriceRaisedAt: productPriceStats.listPriceRaisedAt,
    })
    .from(productPriceStats)
    .where(eq(productPriceStats.productId, productId))
    .limit(1);

  return rows[0] ?? null;
}
