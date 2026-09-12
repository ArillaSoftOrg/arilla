import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { createAlert, deleteAlert, InvalidAlertInputError, listAlerts } from "./alerts.ts";

describe("alerts - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let userId = 0;
  let otherUserId = 0;
  let productId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `e2-alerts-${suffix}@example.test`,
      ]);
      userId = Number(user.rows[0].id);

      const otherUser = await client.query(
        "INSERT INTO app_user (email) VALUES ($1) RETURNING id",
        [`e2-alerts-other-${suffix}@example.test`],
      );
      otherUserId = Number(otherUser.rows[0].id);

      const prod = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'Alarm Test Ürünü') RETURNING id",
        [`e2-alerts-product-${suffix}`],
      );
      productId = Number(prod.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM alert WHERE user_id = ANY($1)", [[userId, otherUserId]]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userId, otherUserId]]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
    });
  });

  it("price_drop icin targetPrice zorunlu kilar", async () => {
    await expect(createAlert(db, { userId, productId, kind: "price_drop" })).rejects.toThrow(
      InvalidAlertInputError,
    );
  });

  it("size_restock icin sizeNorm zorunlu kilar", async () => {
    await expect(createAlert(db, { userId, productId, kind: "size_restock" })).rejects.toThrow(
      InvalidAlertInputError,
    );
  });

  it("olusturur, listeler, ayni (user,product,kind) icin ikinci istekte created=false doner", async () => {
    const first = await createAlert(db, {
      userId,
      productId,
      kind: "price_drop",
      targetPrice: 10000,
    });
    expect(first.created).toBe(true);

    const second = await createAlert(db, {
      userId,
      productId,
      kind: "price_drop",
      targetPrice: 9000,
    });
    expect(second.created).toBe(false);
    expect(second.alertId).toBe(first.alertId);

    const list = await listAlerts(db, userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe("price_drop");
    expect(list[0]?.targetPrice).toBe(10000);

    await deleteAlert(db, { userId, alertId: first.alertId });
    expect(await listAlerts(db, userId)).toHaveLength(0);
  });

  it("farkli kind'lar ayni urun icin ayri satirlar acar (NULL size_norm kisiti gormez)", async () => {
    const priceDrop = await createAlert(db, {
      userId,
      productId,
      kind: "price_drop",
      targetPrice: 5000,
    });
    const restock = await createAlert(db, { userId, productId, kind: "restock" });
    expect(priceDrop.created).toBe(true);
    expect(restock.created).toBe(true);
    expect(priceDrop.alertId).not.toBe(restock.alertId);

    await deleteAlert(db, { userId, alertId: priceDrop.alertId });
    await deleteAlert(db, { userId, alertId: restock.alertId });
  });

  it("baska kullanicinin alarmini silmeye calisirsa found=false doner ve satir kalir", async () => {
    const { alertId } = await createAlert(db, { userId, productId, kind: "restock" });

    const result = await deleteAlert(db, { userId: otherUserId, alertId });
    expect(result.found).toBe(false);
    expect(await listAlerts(db, userId)).toHaveLength(1);

    await deleteAlert(db, { userId, alertId });
  });
});
