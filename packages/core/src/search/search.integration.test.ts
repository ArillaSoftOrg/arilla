import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { UnsupportedSortForIntentError } from "./result-types.ts";
import { search } from "./search.ts";
import type { QueryObject } from "./types.ts";

function baseQuery(overrides: Partial<QueryObject> = {}): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: "",
    filters: {},
    style_tags: [],
    sort: "balanced",
    unparsed: "",
    confidence: 1,
    ...overrides,
  };
}

describe("search() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  it("balanced and best_deal produce different orderings for the same filters (C2 kabul kriteri)", async () => {
    const filters = { category_path: "moda/ayakkabi" };
    const balanced = await search(db, baseQuery({ filters, sort: "balanced" }), { limit: 24 });
    const bestDeal = await search(db, baseQuery({ filters, sort: "best_deal" }), { limit: 24 });

    expect(balanced.items.length).toBeGreaterThan(0);
    const balancedOrder = balanced.items.map((item) => item.productId);
    const bestDealOrder = bestDeal.items.map((item) => item.productId);
    expect(balancedOrder).not.toEqual(bestDealOrder);
  });

  it("excludes list_price_inflated products from best_deal entirely", async () => {
    const inflated = await db.execute(
      sql`SELECT product_id FROM product_price_stats WHERE list_price_inflated`,
    );
    const inflatedIds = new Set(inflated.rows.map((row) => Number(row.product_id)));
    expect(inflatedIds.size).toBeGreaterThan(0);

    const bestDeal = await search(db, baseQuery({ sort: "best_deal" }), { limit: 200 });
    expect(bestDeal.items.length).toBeGreaterThan(0);
    for (const item of bestDeal.items) {
      expect(inflatedIds.has(item.productId)).toBe(false);
    }
  });

  it("closest_match sorts by similarity_edge.score and differs from balanced", async () => {
    const edgeRow = await db.execute(
      sql`SELECT product_a FROM similarity_edge WHERE kind = 'visual' LIMIT 1`,
    );
    const anchorId = Number(edgeRow.rows[0]?.product_a);
    expect(Number.isNaN(anchorId)).toBe(false);

    const closest = await search(
      db,
      baseQuery({
        intent: "similar_cheaper",
        anchor: { type: "product", id: anchorId },
        sort: "closest_match",
      }),
      { limit: 24 },
    );
    const balanced = await search(
      db,
      baseQuery({
        intent: "similar_cheaper",
        anchor: { type: "product", id: anchorId },
        sort: "balanced",
      }),
      { limit: 24 },
    );

    expect(closest.items.length).toBeGreaterThan(0);
    expect(closest.items.map((item) => item.productId)).not.toEqual(
      balanced.items.map((item) => item.productId),
    );
  });

  it("throws when closest_match has no anchor/intent mapping to a similarity_edge.kind", async () => {
    await expect(
      search(db, baseQuery({ intent: "browse", sort: "closest_match" })),
    ).rejects.toBeInstanceOf(UnsupportedSortForIntentError);
  });

  it("matches category_path as a prefix (parent category), not only exact equality", async () => {
    // search() yalnizca aktif merchant'in aktif teklifi olan urunleri dondurur;
    // beklenen sayi da ayni kosulla sayilir (bootstrap katalogu, 0027, pasif
    // merchant'lar da iceriyor).
    const countRow = await db.execute(
      // Ayni gorseli tasiyan urunler tek sonuca iner (0029): gorsel basina say.
      sql`SELECT count(DISTINCT COALESCE(p.primary_image_url, p.id::text)) AS count
          FROM product p JOIN category c ON c.id = p.category_id
          WHERE (c.path = 'moda' OR c.path LIKE 'moda/%')
            AND EXISTS (SELECT 1 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                         WHERE o.product_id = p.id AND o.is_active AND m.is_active)`,
    );
    const expectedCount = Number(countRow.rows[0]?.count ?? 0);
    expect(expectedCount).toBeGreaterThan(0);

    const result = await search(db, baseQuery({ filters: { category_path: "moda" } }), {
      limit: 10_000,
    });
    expect(result.items.length).toBe(expectedCount);
  });

  describe("color filter (sentetik fixture - seed veride normalize renk yok)", () => {
    const fixtureSlug = `c2-test-color-fixture-${Date.now()}`;
    let fixtureProductId = 0;

    beforeAll(async () => {
      await withOwnerClient(async (client) => {
        const merchantResult = await client.query(
          "SELECT id FROM merchant WHERE is_active ORDER BY id LIMIT 1",
        );
        const merchantId = merchantResult.rows[0]?.id;
        const productResult = await client.query(
          `INSERT INTO product (slug, title, color, min_price, offer_count, in_stock_count)
           VALUES ($1, 'C2 Test Urunu', 'black', 100000, 1, 1) RETURNING id`,
          [fixtureSlug],
        );
        fixtureProductId = Number(productResult.rows[0]?.id);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, is_active, in_stock)
           VALUES ($1, $2, $3, 'https://example.test/c2', 'C2 Test Urunu', 100000, true, true)`,
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

    it("filters by normalized color", async () => {
      const result = await search(db, baseQuery({ filters: { color: ["black"] } }), {
        limit: 10_000,
      });
      expect(result.items.some((item) => item.productId === fixtureProductId)).toBe(true);
    });
  });
});
