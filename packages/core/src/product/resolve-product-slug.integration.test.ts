import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { resolveProductSlug } from "./resolve-product-slug.ts";

describe("resolveProductSlug() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  it("returns found for a real seeded slug", async () => {
    const result = await resolveProductSlug(db, "peri-kozmetik-turunc-notali-parfum-lacivert");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.product.productId).toBe(43);
      expect(result.product.title).toBeTruthy();
    }
  });

  it("returns not_found for a nonexistent slug", async () => {
    const result = await resolveProductSlug(db, "bu-slug-hicbir-zaman-var-olmayacak-12345");
    expect(result.status).toBe("not_found");
  });

  describe("product_slug_history redirect (sentetik fixture - seed'de 0 satır)", () => {
    const oldSlug = `c-d3-test-old-slug-${Date.now()}`;

    afterAll(async () => {
      await withOwnerClient(async (client) => {
        await client.query("DELETE FROM product_slug_history WHERE slug = $1", [oldSlug]);
      });
    });

    it("resolves an old slug to the product's current slug", async () => {
      await withOwnerClient(async (client) => {
        await client.query("INSERT INTO product_slug_history (slug, product_id) VALUES ($1, 43)", [
          oldSlug,
        ]);
      });

      const result = await resolveProductSlug(db, oldSlug);
      expect(result.status).toBe("redirect");
      if (result.status === "redirect") {
        expect(result.canonicalSlug).toBe("peri-kozmetik-turunc-notali-parfum-lacivert");
      }
    });
  });
});
