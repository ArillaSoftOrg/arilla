/**
 * Fiyat filtresi, kartta GOSTERILEN fiyatla tutarli olmali (AI denetimi).
 *
 * `price_min/price_max` eskiden `p.min_price`'a (tum aktif tekliflerin en
 * dusugu) bakiyordu; kart ise `best_offer.current_price`'i (mağaza / stok
 * filtresine gore en ucuz teklif) gosterir. Mağaza ya da stok filtresi
 * acikken kullanici 200 TL ustu filtreler, 100 TL'lik gizli bir teklif
 * yuzunden 500 TL'lik bir kart gorurdu.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { search } from "./search.ts";
import type { QueryFilters, QueryObject } from "./types.ts";

function query(filters: QueryFilters): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: "",
    filters,
    style_tags: [],
    sort: "balanced",
    unparsed: "",
    confidence: 1,
  };
}

describe("search() price filters match the displayed price", () => {
  const suffix = `pc-${Date.now()}`;
  let db: Database;
  let cheapMerchant = 0;
  let dearMerchant = 0;
  let productId = 0;
  let cheapOfferId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string): Promise<number> => {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type)
           VALUES ($1, $2, $3, 'xml_feed') RETURNING id`,
          [`${key}-${suffix}`, `Fiyat Testi ${key}`, `${key}-${suffix}.example.test`],
        );
        return Number(row.rows[0].id);
      };
      cheapMerchant = await merchant("ucuz");
      dearMerchant = await merchant("pahali");

      const product = await client.query(
        `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
         VALUES ($1, $2, 10000, 50000, 2, 2) RETURNING id`,
        [`fiyat-${suffix}`, `Fiyat Tutarlilik ${suffix}`],
      );
      productId = Number(product.rows[0].id);

      const offer = async (merchantId: number, key: string, price: number): Promise<number> => {
        const row = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $3, $5, TRUE, TRUE) RETURNING id`,
          [
            merchantId,
            productId,
            `${key}-${suffix}`,
            `https://${key}-${suffix}.example.test/u`,
            price,
          ],
        );
        return Number(row.rows[0].id);
      };
      cheapOfferId = await offer(cheapMerchant, "ucuz", 10_000);
      await offer(dearMerchant, "pahali", 50_000);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE product_id = $1", [productId]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [
        [cheapMerchant, dearMerchant],
      ]);
    });
  });

  async function find(filters: QueryFilters) {
    const result = await search(db, query(filters), { limit: 200 });
    return result.items.find((item) => item.productId === productId);
  }

  it("control: without merchant/stock filters the displayed price is the cheapest offer", async () => {
    const item = await find({ price_max: 20_000 });
    expect(item?.minPrice).toBe(10_000);
  });

  it("price_max uses the offer that is actually displayed when a merchant filter is on", async () => {
    // Gosterilen fiyat 500 TL (yalnizca pahali magaza): 200 TL ustu filtrede olmamali.
    const item = await find({ merchant_ids: [dearMerchant], price_max: 20_000 });
    expect(item).toBeUndefined();
  });

  it("price_min uses the displayed price when a merchant filter is on", async () => {
    const item = await find({ merchant_ids: [dearMerchant], price_min: 40_000 });
    expect(item?.minPrice).toBe(50_000);
  });

  it("price_max follows the in-stock offer when only in-stock offers are requested", async () => {
    await withOwnerClient((client) =>
      client.query("UPDATE offer SET in_stock = FALSE WHERE id = $1", [cheapOfferId]),
    );
    try {
      const item = await find({ in_stock_only: true, price_max: 20_000 });
      expect(item).toBeUndefined();
    } finally {
      await withOwnerClient((client) =>
        client.query("UPDATE offer SET in_stock = TRUE WHERE id = $1", [cheapOfferId]),
      );
    }
  });
});
