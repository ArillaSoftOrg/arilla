import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getDeals } from "./get-deals.ts";

describe("getDeals() - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let dealProductId = 0;
  let inflatedProductId = 0;
  let staleDropProductId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const makeProductWithStats = async (
        title: string,
        minPrice: number,
        opts: { listPriceInflated: boolean; lastDropHoursAgo: number },
      ) => {
        const result = await client.query(
          "INSERT INTO product (slug, title, min_price, in_stock_count) VALUES ($1, $2, $3, 5) RETURNING id",
          [`e4-deal-${title}-${suffix}`, title, minPrice],
        );
        const productId = Number(result.rows[0].id);
        await client.query(
          `INSERT INTO product_price_stats
             (product_id, median_90d, list_price_inflated, last_drop_at)
           VALUES ($1, 10000, $2, now() - ($3 || ' hours')::interval)`,
          [productId, opts.listPriceInflated, opts.lastDropHoursAgo],
        );
        return productId;
      };

      dealProductId = await makeProductWithStats("gercek-firsat", 7000, {
        listPriceInflated: false,
        lastDropHoursAgo: 1,
      });
      inflatedProductId = await makeProductWithStats("sahte-indirim", 7000, {
        listPriceInflated: true,
        lastDropHoursAgo: 1,
      });
      staleDropProductId = await makeProductWithStats("eski-dusus", 7000, {
        listPriceInflated: false,
        lastDropHoursAgo: 24 * 10,
      });
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      const ids = [dealProductId, inflatedProductId, staleDropProductId];
      await client.query("DELETE FROM product_price_stats WHERE product_id = ANY($1)", [ids]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [ids]);
    });
  });

  it("yalnizca gercek, yakin zamanli dususleri doner - sahte indirim ve eski dususu haric tutar", async () => {
    const deals = await getDeals(db, 200);
    const productIds = deals.map((deal) => deal.productId);

    expect(productIds).toContain(dealProductId);
    expect(productIds).not.toContain(inflatedProductId);
    expect(productIds).not.toContain(staleDropProductId);

    const deal = deals.find((d) => d.productId === dealProductId);
    expect(deal?.savingsKurus).toBe(3000);
    expect(deal?.savingsPercent).toBe(30);
  });
});
