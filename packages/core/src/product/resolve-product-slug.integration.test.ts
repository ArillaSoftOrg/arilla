import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { resolveProductSlug } from "./resolve-product-slug.ts";

/**
 * Kendi urununu kurar: tohumdaki satir kimlikleri ve slug'lar tohum degistikce
 * kayar, sabit bir id/slug'a baglanan test gercek bir hatayi degil tohumu olcer.
 */
describe("resolveProductSlug() - integration (gercek Postgres, kendi fixture'i)", () => {
  let db: Database;
  const suffix = Date.now();
  const currentSlug = `c-d3-test-current-slug-${suffix}`;
  let productId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const result = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'C-D3 Slug Test Urunu') RETURNING id",
        [currentSlug],
      );
      productId = Number(result.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM product_slug_history WHERE product_id = $1", [productId]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
    });
  });

  it("returns found for an existing slug", async () => {
    const result = await resolveProductSlug(db, currentSlug);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.product.productId).toBe(productId);
      expect(result.product.title).toBe("C-D3 Slug Test Urunu");
    }
  });

  it("returns not_found for a nonexistent slug", async () => {
    const result = await resolveProductSlug(db, "bu-slug-hicbir-zaman-var-olmayacak-12345");
    expect(result.status).toBe("not_found");
  });

  describe("product_slug_history redirect", () => {
    const oldSlug = `c-d3-test-old-slug-${suffix}`;

    it("resolves an old slug to the product's current slug", async () => {
      await withOwnerClient(async (client) => {
        await client.query("INSERT INTO product_slug_history (slug, product_id) VALUES ($1, $2)", [
          oldSlug,
          productId,
        ]);
      });

      const result = await resolveProductSlug(db, oldSlug);
      expect(result.status).toBe("redirect");
      if (result.status === "redirect") {
        expect(result.canonicalSlug).toBe(currentSlug);
      }
    });
  });
});
