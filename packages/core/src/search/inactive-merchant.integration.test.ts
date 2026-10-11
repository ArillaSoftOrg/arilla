/**
 * Pasif magazanin teklifi hicbir yuzeyde gorunmemeli (AI denetimi).
 *
 * Arama (`bestOfferCte`) ve urun ozetleri (`refresh-aggregates`) `m.is_active`
 * uygular; mağaza karsilastirma, urun fiyat karsilastirma, alternatifler ve
 * gorsel arama yalnizca `o.is_active` uyguluyordu. Pasife alinan bir magazanin
 * (orn. para birimi dogrulanamadi) fiyati urun sayfasinda ve alternatif
 * kartlarinda gorunmeye devam ediyordu; kart, ozet ve arama farkli fiyat
 * soyluyordu.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProductPriceComparison } from "../product/get-price-comparison.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { compareMerchants } from "./compare-merchants.ts";
import { findAlternatives } from "./find-alternatives.ts";
import { searchByImageVector } from "./visual-search.ts";

const MODEL = "test-inactive-merchant-model";

function axis(index: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[index] = 1;
  return vector;
}

describe("inactive merchants are invisible on every price surface", () => {
  const suffix = `im-${Date.now()}`;
  let db: Database;
  let activeMerchant = 0;
  let inactiveMerchant = 0;
  let anchorId = 0;
  let productId = 0;
  const offerIds: number[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string, active: boolean): Promise<number> => {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ($1, $2, $3, 'xml_feed', $4) RETURNING id`,
          [`${key}-${suffix}`, `Pasif Testi ${key}`, `${key}-${suffix}.example.test`, active],
        );
        return Number(row.rows[0].id);
      };
      activeMerchant = await merchant("aktif", true);
      inactiveMerchant = await merchant("pasif", false);

      const product = async (key: string, price: number): Promise<number> => {
        const row = await client.query(
          `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
           VALUES ($1, $2, $3, $3, 1, 1) RETURNING id`,
          [`${key}-${suffix}`, `Pasif Magaza ${key} ${suffix}`, price],
        );
        return Number(row.rows[0].id);
      };
      anchorId = await product("capa", 70_000);
      productId = await product("hedef", 50_000);

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
        const id = Number(row.rows[0].id);
        offerIds.push(id);
        return id;
      };
      // Aktif magaza 500 TL, PASIF magaza 100 TL (daha ucuz ama gorunmemeli).
      const activeOffer = await offer(activeMerchant, "aktif", 50_000);
      await offer(inactiveMerchant, "pasif", 10_000);

      await client.query(
        "INSERT INTO similarity_edge (product_a, product_b, kind, score) VALUES ($1, $2, 'visual', 0.9)",
        [anchorId, productId],
      );
      await client.query(
        `INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
         VALUES ('offer', $1, 'image', $2, $3::vector)`,
        [activeOffer, MODEL, `[${axis(11).join(",")}]`],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM embedding WHERE target_type = 'offer' AND target_id = ANY($1)",
        [offerIds],
      );
      await client.query("DELETE FROM similarity_edge WHERE product_a = $1", [anchorId]);
      await client.query("DELETE FROM offer WHERE product_id = $1", [productId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [[anchorId, productId]]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [
        [activeMerchant, inactiveMerchant],
      ]);
    });
  });

  it("compareMerchants lists only active merchants", async () => {
    const offers = await compareMerchants(db, productId);
    expect(offers.map((offer) => offer.merchantId)).toEqual([activeMerchant]);
  });

  it("the product price comparison ignores inactive merchants", async () => {
    const comparison = await getProductPriceComparison(db, productId, null);
    expect(comparison.merchantOffers.map((offer) => offer.merchantId)).toEqual([activeMerchant]);
  });

  it("findAlternatives shows the active merchant's price", async () => {
    const alternatives = await findAlternatives(db, anchorId);
    const item = alternatives.find((entry) => entry.productId === productId);
    expect(item?.minPrice).toBe(50_000);
  });

  it("visual search shows the active merchant's price", async () => {
    const items = await searchByImageVector(db, axis(11), MODEL, { limit: 5 });
    const item = items.find((entry) => entry.productId === productId);
    expect(item?.minPrice).toBe(50_000);
  });
});
