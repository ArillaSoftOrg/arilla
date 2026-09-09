import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { compareMerchants } from "./compare-merchants.ts";

describe("compareMerchants() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  describe("kargo dahil toplam siralama (sentetik fixture: en dusuk fiyat != en dusuk toplam)", () => {
    const fixtureSlug = `c2-test-compare-fixture-${Date.now()}`;
    let fixtureProductId = 0;
    let merchantIds: number[] = [];

    beforeAll(async () => {
      await withOwnerClient(async (client) => {
        const merchants = await client.query("SELECT id FROM merchant ORDER BY id LIMIT 2");
        merchantIds = merchants.rows.map((row) => Number(row.id));

        const productResult = await client.query(
          `INSERT INTO product (slug, title, min_price, offer_count, in_stock_count)
           VALUES ($1, 'C2 Karsilastirma Testi', 100000, 2, 2) RETURNING id`,
          [fixtureSlug],
        );
        fixtureProductId = Number(productResult.rows[0]?.id);

        // Ucuz fiyat, pahali kargo -> toplamda daha pahali.
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
             current_price, shipping_cost, is_active, in_stock)
           VALUES ($1, $2, $3, 'https://example.test/cheap-price', 'Ucuz fiyat', 100000, 5000, true, true)`,
          [merchantIds[0], fixtureProductId, `${fixtureSlug}-a`],
        );
        // Pahali fiyat, ucretsiz kargo -> toplamda daha ucuz.
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
             current_price, shipping_cost, is_active, in_stock)
           VALUES ($1, $2, $3, 'https://example.test/cheap-total', 'Ucuz toplam', 102000, 0, true, true)`,
          [merchantIds[1], fixtureProductId, `${fixtureSlug}-b`],
        );
      });
    });

    afterAll(async () => {
      await withOwnerClient(async (client) => {
        await client.query("DELETE FROM offer WHERE product_id = $1", [fixtureProductId]);
        await client.query("DELETE FROM product WHERE id = $1", [fixtureProductId]);
      });
    });

    it("sorts by shipping-inclusive total, not raw price", async () => {
      const offers = await compareMerchants(db, fixtureProductId);

      expect(offers).toHaveLength(2);
      expect(offers[0]?.currentPrice).toBe(102000);
      expect(offers[0]?.effectiveTotal).toBe(102000);
      expect(offers[1]?.currentPrice).toBe(100000);
      expect(offers[1]?.effectiveTotal).toBe(105000);
      // Ucuz-fiyat teklif tek basina fiyata gore birinci olurdu ama toplamda ikinci.
      expect(offers[0]?.currentPrice).toBeGreaterThan(offers[1]?.currentPrice ?? 0);
    });
  });

  describe("ucretsiz kargo esigi", () => {
    const fixtureSlug = `c2-test-free-shipping-${Date.now()}`;
    let fixtureProductId = 0;

    beforeAll(async () => {
      await withOwnerClient(async (client) => {
        const merchantResult = await client.query("SELECT id FROM merchant LIMIT 1");
        const merchantId = Number(merchantResult.rows[0]?.id);

        const productResult = await client.query(
          `INSERT INTO product (slug, title, min_price, offer_count, in_stock_count)
           VALUES ($1, 'C2 Ucretsiz Kargo Testi', 200000, 1, 1) RETURNING id`,
          [fixtureSlug],
        );
        fixtureProductId = Number(productResult.rows[0]?.id);

        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
             current_price, shipping_cost, free_shipping_threshold, is_active, in_stock)
           VALUES ($1, $2, $3, 'https://example.test/free-shipping', 'Esik asildi', 200000, 5000, 150000, true, true)`,
          [merchantId, fixtureProductId, fixtureSlug],
        );
      });
    });

    afterAll(async () => {
      await withOwnerClient(async (client) => {
        await client.query("DELETE FROM offer WHERE product_id = $1", [fixtureProductId]);
        await client.query("DELETE FROM product WHERE id = $1", [fixtureProductId]);
      });
    });

    it("zeroes out shipping once the free-shipping threshold is met", async () => {
      const offers = await compareMerchants(db, fixtureProductId);
      expect(offers).toHaveLength(1);
      expect(offers[0]?.effectiveShipping).toBe(0);
      expect(offers[0]?.effectiveTotal).toBe(200000);
    });
  });
});
