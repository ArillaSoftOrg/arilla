import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { listSavedItems, removeSavedItem, saveItem } from "./saved-items.ts";

describe("saved-items - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let userId = 0;
  let productId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `e2-saved-${suffix}@example.test`,
      ]);
      userId = Number(user.rows[0].id);

      const prod = await client.query(
        "INSERT INTO product (slug, title, min_price, offer_count) VALUES ($1, 'Kayıt Test Ürünü', 12345, 2) RETURNING id",
        [`e2-saved-product-${suffix}`],
      );
      productId = Number(prod.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM saved_item WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
    });
  });

  it("kaydeder, listeler, ikinci kayıtta no-op döner, sonra kaldırır", async () => {
    const first = await saveItem(db, { userId, productId });
    expect(first.created).toBe(true);

    const list = await listSavedItems(db, userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.productId).toBe(productId);
    expect(list[0]?.title).toBe("Kayıt Test Ürünü");

    const second = await saveItem(db, { userId, productId });
    expect(second.created).toBe(false);
    expect(await listSavedItems(db, userId)).toHaveLength(1);

    await removeSavedItem(db, { userId, productId });
    expect(await listSavedItems(db, userId)).toHaveLength(0);
  });
});
