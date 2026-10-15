/**
 * Karar 0120: fiyatsız ürünün sitemap/indeks uygunluğu (varsayılan kapalı, açık kriterler)
 * ve fiyatsız teklif çıkışları.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { isProductSitemapEligible, listSitemapEligibleProducts } from "./sitemap-eligibility.ts";
import { listUnpricedOfferExits } from "./unpriced-offers.ts";

const DOMAIN = "test-sitemap-unpriced.example";

describe("fiyatsız ürün uygunluğu - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  let merchantId = 0;
  let categoryId = 0;
  let brandId = 0;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      merchantId = Number(
        (
          await c.query(
            `INSERT INTO merchant (slug, name, domain, source_type)
             VALUES ('test-sitemap-unpriced', 'Test Mağaza', $1, 'user_discovered') RETURNING id`,
            [DOMAIN],
          )
        ).rows[0].id,
      );
      categoryId = Number(
        (
          await c.query(
            `INSERT INTO category (slug, name, path, is_discoverable)
             VALUES ('test-unpriced-cat', 'Telefon', 'test-unpriced-cat', TRUE) RETURNING id`,
          )
        ).rows[0].id,
      );
      brandId = Number(
        (
          await c.query(
            `INSERT INTO brand (slug, name, name_norm) VALUES ('test-unpriced-marka', 'Marka', 'testunpricedmarka')
             RETURNING id`,
          )
        ).rows[0].id,
      );
      async function product(
        key: string,
        opts: { brand?: boolean; attributes?: Record<string, string>; title?: string },
      ) {
        const r = await c.query(
          `INSERT INTO product (slug, title, brand_id, category_id, offer_count, primary_image_url, attributes)
           VALUES ($1, $2, $3, $4, 0, 'https://example.com/x.jpg', $5::jsonb) RETURNING id`,
          [
            `test-unpriced-${key}`,
            opts.title ?? "Marka Akıllı Telefon 128 GB Siyah",
            opts.brand === false ? null : brandId,
            categoryId,
            JSON.stringify(
              opts.attributes ?? { depolama: "128 GB", renk: "Siyah", ekran: "6,1 inç" },
            ),
          ],
        );
        ids[key] = Number(r.rows[0].id);
      }
      async function offer(key: string, opts: { active?: boolean; ageDays?: number } = {}) {
        const r = await c.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price,
                              is_active, last_seen_at)
           VALUES ($1, $2, $3, $4, 'x', NULL, $5, now() - make_interval(days => $6)) RETURNING id`,
          [
            merchantId,
            ids[key],
            `ext-${key}`,
            `https://${DOMAIN}/${key}`,
            opts.active ?? true,
            opts.ageDays ?? 1,
          ],
        );
        ids[`offer-${key}`] = Number(r.rows[0].id);
      }
      await product("rich", {});
      await offer("rich");
      await product("thin", { attributes: { renk: "Siyah" } });
      await offer("thin");
      await product("nobrand", { brand: false });
      await offer("nobrand");
      await product("shorttitle", { title: "Telefon" });
      await offer("shorttitle");
      await product("removed", {});
      await offer("removed", { active: false });
      await product("stale", {});
      await offer("stale", { ageDays: 30 });
    });
  });

  afterEach(() => {
    delete process.env.SEO_UNPRICED_PRODUCTS_ENABLED;
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await c.query("DELETE FROM product WHERE id = ANY($1::bigint[])", [
        Object.entries(ids)
          .filter(([k]) => !k.startsWith("offer-"))
          .map(([, v]) => v),
      ]);
      await c.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await c.query("DELETE FROM category WHERE id = $1", [categoryId]);
      await c.query("DELETE FROM brand WHERE id = $1", [brandId]);
    });
  });

  it("bayrak kapalıyken fiyatsız ürün haritaya girmez", async () => {
    expect(await isProductSitemapEligible(db, ids.rich as number)).toBe(false);
  });

  it("bayrak açıkken yalnızca açık kriterleri sağlayan ürün girer", async () => {
    process.env.SEO_UNPRICED_PRODUCTS_ENABLED = "true";
    expect(await isProductSitemapEligible(db, ids.rich as number)).toBe(true);
    for (const key of ["thin", "nobrand", "shorttitle", "removed", "stale"]) {
      expect(await isProductSitemapEligible(db, ids[key] as number), key).toBe(false);
    }
    const all = Object.entries(ids)
      .filter(([k]) => !k.startsWith("offer-"))
      .map(([, v]) => v);
    const rows = await listSitemapEligibleProducts(db, {
      minId: Math.min(...all) - 1,
      maxId: Math.max(...all),
    });
    expect(rows.map((r) => r.slug)).toEqual(["test-unpriced-rich"]);
  });

  it("fiyatsız çıkış: yalnızca aktif, fiyatsız teklif; fiyat döndürülmez", async () => {
    const exits = await listUnpricedOfferExits(db, ids.rich as number);
    expect(exits).toEqual([
      expect.objectContaining({ offerId: ids["offer-rich"], merchantName: "Test Mağaza" }),
    ]);
    expect(Object.keys(exits[0] ?? {})).not.toContain("price");
    expect(await listUnpricedOfferExits(db, ids.removed as number)).toEqual([]);
  });
});
