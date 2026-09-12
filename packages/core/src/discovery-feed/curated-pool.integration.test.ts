import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  addToCuratedPool,
  listCuratedPool,
  ProductNotDiscoverableError,
  ProductNotFoundError,
  removeFromCuratedPool,
} from "./curated-pool.ts";

describe("curated-pool - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let discoverableProductId = 0;
  let hiddenCategoryProductId = 0;
  let hiddenCategoryId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const product = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'Kesfet Test Urunu') RETURNING id",
        [`e4-curated-${suffix}`],
      );
      discoverableProductId = Number(product.rows[0].id);

      const category = await client.query(
        "INSERT INTO category (slug, name, path, is_discoverable) VALUES ($1, 'Mahrem', 'mahrem', false) RETURNING id",
        [`e4-hidden-category-${suffix}`],
      );
      hiddenCategoryId = Number(category.rows[0].id);

      const hiddenProduct = await client.query(
        "INSERT INTO product (slug, title, category_id) VALUES ($1, 'Gizli Urun', $2) RETURNING id",
        [`e4-hidden-${suffix}`, hiddenCategoryId],
      );
      hiddenCategoryProductId = Number(hiddenProduct.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM public_find WHERE product_id = ANY($1)", [
        [discoverableProductId, hiddenCategoryProductId],
      ]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [
        [discoverableProductId, hiddenCategoryProductId],
      ]);
      await client.query("DELETE FROM category WHERE id = $1", [hiddenCategoryId]);
    });
  });

  it("var olmayan urun icin ProductNotFoundError firlatir", async () => {
    await expect(addToCuratedPool(db, 999_999_999)).rejects.toThrow(ProductNotFoundError);
  });

  it("is_discoverable=false kategorideki urunu reddeder", async () => {
    await expect(addToCuratedPool(db, hiddenCategoryProductId)).rejects.toThrow(
      ProductNotDiscoverableError,
    );
  });

  it("ekler, listeler, tekrar eklemek hata vermez (upsert), sonra kaldirir", async () => {
    await addToCuratedPool(db, discoverableProductId);
    await addToCuratedPool(db, discoverableProductId);

    const pool = await listCuratedPool(db);
    expect(pool.some((item) => item.productId === discoverableProductId)).toBe(true);

    await removeFromCuratedPool(db, discoverableProductId);
    const afterRemoval = await listCuratedPool(db);
    expect(afterRemoval.some((item) => item.productId === discoverableProductId)).toBe(false);
  });
});
