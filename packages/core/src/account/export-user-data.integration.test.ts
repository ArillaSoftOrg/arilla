import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { exportUserData, UserNotFoundError } from "./export-user-data.ts";

describe("exportUserData() - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const email = `e3-export-${suffix}@example.test`;
  let userId = 0;
  let productId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        email,
      ]);
      userId = Number(user.rows[0].id);

      const product = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'Dışa Aktarım Ürünü') RETURNING id",
        [`e3-export-product-${suffix}`],
      );
      productId = Number(product.rows[0].id);

      await client.query("INSERT INTO saved_item (user_id, product_id) VALUES ($1, $2)", [
        userId,
        productId,
      ]);
      await client.query(
        "INSERT INTO alert (user_id, product_id, kind, target_price) VALUES ($1, $2, 'price_drop', 5000)",
        [userId, productId],
      );
      await client.query(
        "INSERT INTO user_size_profile (user_id, category_path, size_norm) VALUES ($1, 'ayakkabi', '42')",
        [userId],
      );
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted) VALUES ($1, 'marketing_email', true)",
        [userId],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM saved_item WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM alert WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM user_size_profile WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM user_consent WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
    });
  });

  it("kullanıcının tüm verisini toplar", async () => {
    const data = await exportUserData(db, userId);

    expect(data.profile.email).toBe(email);
    expect(data.savedItems).toHaveLength(1);
    expect(data.savedItems[0]?.productTitle).toBe("Dışa Aktarım Ürünü");
    expect(data.alerts).toHaveLength(1);
    expect(data.alerts[0]?.targetPrice).toBe(5000);
    expect(data.sizeProfile).toEqual([{ categoryPath: "ayakkabi", sizeNorm: "42" }]);
    expect(data.consents).toHaveLength(1);
    expect(data.consents[0]?.kind).toBe("marketing_email");
  });

  it("olmayan kullanıcı için UserNotFoundError fırlatır", async () => {
    await expect(exportUserData(db, 999_999_999)).rejects.toThrow(UserNotFoundError);
  });
});
