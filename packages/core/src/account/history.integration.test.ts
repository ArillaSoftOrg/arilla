import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { clearHistory, listHistory } from "./history.ts";

describe("history - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let userId = 0;
  let productId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `e2-history-${suffix}@example.test`,
      ]);
      userId = Number(user.rows[0].id);

      const prod = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'Geçmiş Test Ürünü') RETURNING id",
        [`e2-history-product-${suffix}`],
      );
      productId = Number(prod.rows[0].id);

      // product_view yazımı yalnızca test fixture'ı içindir - packages/core
      // burayı yazmıyor, bkz. history.ts başlığı (rıza E3'e kadar bekliyor).
      await client.query(
        "INSERT INTO product_view (user_id, session_id, product_id) VALUES ($1, 'e2-history-session', $2)",
        [userId, productId],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM product_view WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
    });
  });

  it("listeler ve gercekten siler", async () => {
    const list = await listHistory(db, userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.productId).toBe(productId);

    await clearHistory(db, userId);
    expect(await listHistory(db, userId)).toHaveLength(0);
  });
});
