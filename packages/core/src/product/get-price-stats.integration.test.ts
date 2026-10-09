import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getPriceStats } from "./get-price-stats.ts";

/**
 * `product_price_stats` toplu isin (python -m similarity --prices) ciktisidir;
 * tohum onu yazmaz. Okuyucu testi kendi satirini kurar.
 */
describe("getPriceStats() - integration (gercek Postgres, kendi fixture'i)", () => {
  let db: Database;
  const suffix = Date.now();
  let productId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const result = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'Fiyat Istatistigi Test Urunu') RETURNING id",
        [`price-stats-reader-${suffix}`],
      );
      productId = Number(result.rows[0].id);
      await client.query(
        `INSERT INTO product_price_stats
           (product_id, min_30d, min_90d, max_90d, median_90d, current_percentile,
            drop_count_90d, last_drop_at, list_price_inflated, list_price_raised_at)
         VALUES ($1, 9000, 9000, 15000, 12000, 0, 3, now() - interval '2 days', TRUE,
                 now() - interval '10 days')`,
        [productId],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM product_price_stats WHERE product_id = $1", [productId]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
    });
  });

  it("returns the inflated + lowest-90d stats for a known product", async () => {
    const stats = await getPriceStats(db, productId);
    expect(stats).not.toBeNull();
    expect(stats?.currentPercentile).toBe(0);
    expect(stats?.listPriceInflated).toBe(true);
    expect(stats?.dropCount90d).toBe(3);
    expect(stats?.min90d).toBe(9000);
    expect(stats?.median90d).toBe(12000);
  });

  it("returns null for a product with no stats row", async () => {
    const stats = await getPriceStats(db, 999_999_999);
    expect(stats).toBeNull();
  });
});
