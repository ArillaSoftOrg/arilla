import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getSizeOptions } from "./get-size-options.ts";

/**
 * Kendi magaza/urun/teklif/varyantlarini kurar: tohumdaki urun kimlikleri tohum
 * degistikce kayar, sabit id'ye baglanan test tohumu olcer, kodu degil.
 */
describe("getSizeOptions() - integration (gercek Postgres, kendi fixture'i)", () => {
  let db: Database;
  const suffix = Date.now();
  const domain = `size-options-${suffix}.example.test`;
  let merchantId = 0;
  let apparelId = 0;
  let perfumeId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'Beden Test Magazasi', $2, 'xml_feed') RETURNING id`,
        [`size-options-${suffix}`, domain],
      );
      merchantId = Number(merchant.rows[0].id);

      const product = async (slug: string) =>
        Number(
          (
            await client.query("INSERT INTO product (slug, title) VALUES ($1, $1) RETURNING id", [
              `${slug}-${suffix}`,
            ])
          ).rows[0].id,
        );
      apparelId = await product("size-options-apparel");
      perfumeId = await product("size-options-perfume");

      const offer = async (productId: number, key: string) =>
        Number(
          (
            await client.query(
              `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                                  current_price, is_active, in_stock)
               VALUES ($1, $2, $3, $4, $3, 100000, TRUE, TRUE) RETURNING id`,
              [merchantId, productId, `${key}-${suffix}`, `https://${domain}/${key}`],
            )
          ).rows[0].id,
        );
      // Iki teklif beden stokunda anlasmiyor: bir bedenin "var" sayilmasi icin
      // en az bir teklifte stokta olmasi yeter.
      const first = await offer(apparelId, "apparel-a");
      const second = await offer(apparelId, "apparel-b");
      await offer(perfumeId, "perfume");

      const variants: Array<[number, string, boolean]> = [
        [first, "xl", false],
        [first, "l", true],
        [first, "m", false],
        [first, "s", true],
        [first, "xs", false],
        [second, "m", true],
        [second, "xl", true],
        [second, "xs", false],
      ];
      for (const [offerId, size, inStock] of variants) {
        await client.query(
          `INSERT INTO offer_variant (offer_id, external_id, size_label, size_norm, in_stock)
           VALUES ($1, $2, $3, $4, $5)`,
          [offerId, `${offerId}-${size}`, size.toUpperCase(), size, inStock],
        );
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [[apparelId, perfumeId]]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    });
  });

  it("marks a size available if in stock on at least one offer (cross-offer disagreement)", async () => {
    const sizes = await getSizeOptions(db, apparelId);
    const bySize = Object.fromEntries(sizes.map((s) => [s.sizeNorm, s.inStock]));
    expect(bySize.l).toBe(true);
    expect(bySize.m).toBe(true);
    expect(bySize.s).toBe(true);
    expect(bySize.xl).toBe(true);
    expect(bySize.xs).toBe(false);
  });

  it("sorts letter sizes by the fixed rank, not alphabetically", async () => {
    const sizes = await getSizeOptions(db, apparelId);
    const order = sizes.map((s) => s.sizeNorm);
    expect(order).toEqual(["xs", "s", "m", "l", "xl"]);
  });

  it("returns an empty array for a product with no size variants (e.g. a perfume)", async () => {
    const sizes = await getSizeOptions(db, perfumeId);
    expect(sizes).toEqual([]);
  });
});
