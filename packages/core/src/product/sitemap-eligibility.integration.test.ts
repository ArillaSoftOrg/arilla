import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  isProductSitemapEligible,
  listSitemapEligibleProducts,
  maxSitemapProductId,
} from "./sitemap-eligibility.ts";

const DOMAIN = "test-sitemap-eligibility.example";

describe("sitemap eligibility - integration (real Postgres)", () => {
  let db: Database;
  let merchantId = 0;
  let discoverableCategoryId = 0;
  let hiddenCategoryId = 0;
  let multiOfferId = 0;
  let oldSingleOfferId = 0;
  let freshSingleOfferId = 0;
  let hiddenCategoryProductId = 0;
  let noImageId = 0;

  beforeAll(async () => {
    db = getTestDb();

    await withOwnerClient(async (client) => {
      const merchantRow = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ('test-sitemap-elig', 'Test Sitemap Elig', $1, 'user_discovered')
         RETURNING id`,
        [DOMAIN],
      );
      merchantId = Number(merchantRow.rows[0].id);

      const discoverable = await client.query(
        `INSERT INTO category (slug, name, path, is_discoverable)
         VALUES ('test-sitemap-elig-visible', 'Görünür', 'test-sitemap-elig-visible', TRUE)
         RETURNING id`,
      );
      discoverableCategoryId = Number(discoverable.rows[0].id);

      const hidden = await client.query(
        `INSERT INTO category (slug, name, path, is_discoverable)
         VALUES ('test-sitemap-elig-hidden', 'Gizli', 'test-sitemap-elig-hidden', FALSE)
         RETURNING id`,
      );
      hiddenCategoryId = Number(hidden.rows[0].id);

      async function makeProduct(
        key: string,
        opts: { categoryId: number; offerCount: number; imageUrl: string | null },
      ): Promise<number> {
        const row = await client.query(
          `INSERT INTO product (slug, title, category_id, offer_count, primary_image_url)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            `test-sitemap-elig-${key}`,
            `Test ürün ${key}`,
            opts.categoryId,
            opts.offerCount,
            opts.imageUrl,
          ],
        );
        return Number(row.rows[0].id);
      }

      async function makeOffer(productId: number, externalId: string): Promise<number> {
        const row = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price)
           VALUES ($1, $2, $3, $4, 'x', 100)
           RETURNING id`,
          [merchantId, productId, externalId, `https://${DOMAIN}/${externalId}`],
        );
        return Number(row.rows[0].id);
      }

      async function addPricePoint(offerId: number, daysAgo: number): Promise<void> {
        await client.query(
          `INSERT INTO price_point (offer_id, observed_at, price, in_stock)
           VALUES ($1, now() - (INTERVAL '1 day' * $2), 100, TRUE)`,
          [offerId, daysAgo],
        );
      }

      // A: iki aktif teklif -> uygun
      multiOfferId = await makeProduct("multi-offer", {
        categoryId: discoverableCategoryId,
        offerCount: 2,
        imageUrl: "https://example.com/a.jpg",
      });
      await makeOffer(multiOfferId, "a-1");
      await makeOffer(multiOfferId, "a-2");

      // B: tek teklif, 20 gunluk fiyat gecmisi -> uygun
      oldSingleOfferId = await makeProduct("old-single-offer", {
        categoryId: discoverableCategoryId,
        offerCount: 1,
        imageUrl: "https://example.com/b.jpg",
      });
      const offerB = await makeOffer(oldSingleOfferId, "b-1");
      await addPricePoint(offerB, 20);

      // C: tek teklif, yalnizca 2 gunluk fiyat gecmisi -> uygun degil
      freshSingleOfferId = await makeProduct("fresh-single-offer", {
        categoryId: discoverableCategoryId,
        offerCount: 1,
        imageUrl: "https://example.com/c.jpg",
      });
      const offerC = await makeOffer(freshSingleOfferId, "c-1");
      await addPricePoint(offerC, 2);

      // D: iki teklif ama kategori gizli -> uygun degil
      hiddenCategoryProductId = await makeProduct("hidden-category", {
        categoryId: hiddenCategoryId,
        offerCount: 2,
        imageUrl: "https://example.com/d.jpg",
      });
      await makeOffer(hiddenCategoryProductId, "d-1");
      await makeOffer(hiddenCategoryProductId, "d-2");

      // E: iki teklif, kategori uygun ama gorsel yok -> uygun degil
      noImageId = await makeProduct("no-image", {
        categoryId: discoverableCategoryId,
        offerCount: 2,
        imageUrl: null,
      });
      await makeOffer(noImageId, "e-1");
      await makeOffer(noImageId, "e-2");
    });
  });

  afterAll(async () => {
    const allProductIds = [
      multiOfferId,
      oldSingleOfferId,
      freshSingleOfferId,
      hiddenCategoryProductId,
      noImageId,
    ];
    await withOwnerClient(async (client) => {
      await client.query(
        `DELETE FROM price_point WHERE offer_id IN (
           SELECT id FROM offer WHERE merchant_id = $1)`,
        [merchantId],
      );
      await client.query(`DELETE FROM offer WHERE merchant_id = $1`, [merchantId]);
      await client.query(`DELETE FROM product WHERE id = ANY($1::bigint[])`, [allProductIds]);
      await client.query(`DELETE FROM merchant WHERE id = $1`, [merchantId]);
      await client.query(`DELETE FROM category WHERE id = ANY($1::bigint[])`, [
        [discoverableCategoryId, hiddenCategoryId],
      ]);
    });
  });

  it("is eligible with 2+ active offers", async () => {
    expect(await isProductSitemapEligible(db, multiOfferId)).toBe(true);
  });

  it("is eligible with a single offer once 14+ days of price history accumulated", async () => {
    expect(await isProductSitemapEligible(db, oldSingleOfferId)).toBe(true);
  });

  it("is not eligible with a single offer under 14 days of history", async () => {
    expect(await isProductSitemapEligible(db, freshSingleOfferId)).toBe(false);
  });

  it("is not eligible when the category is not discoverable", async () => {
    expect(await isProductSitemapEligible(db, hiddenCategoryProductId)).toBe(false);
  });

  it("is not eligible without a primary image", async () => {
    expect(await isProductSitemapEligible(db, noImageId)).toBe(false);
  });

  it("listSitemapEligibleProducts returns exactly the eligible slugs in the id range", async () => {
    const allProductIds = [
      multiOfferId,
      oldSingleOfferId,
      freshSingleOfferId,
      hiddenCategoryProductId,
      noImageId,
    ];
    const minId = Math.min(...allProductIds) - 1;
    const maxId = Math.max(...allProductIds);
    const rows = await listSitemapEligibleProducts(db, { minId, maxId });
    const slugs = rows.map((row) => row.slug).sort();
    expect(slugs).toEqual(
      ["test-sitemap-elig-multi-offer", "test-sitemap-elig-old-single-offer"].sort(),
    );
  });

  it("maxSitemapProductId is at least the highest id we just inserted", async () => {
    const max = await maxSitemapProductId(db);
    expect(max).toBeGreaterThanOrEqual(
      Math.max(
        multiOfferId,
        oldSingleOfferId,
        freshSingleOfferId,
        hiddenCategoryProductId,
        noImageId,
      ),
    );
  });
});
