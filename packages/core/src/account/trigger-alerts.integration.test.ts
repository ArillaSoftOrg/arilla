import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { createAlert } from "./alerts.ts";
import { triggerAlerts } from "./trigger-alerts.ts";

/** Gerçek Mailpit gerektirir (`notified_at` yalnızca gönderim başarılıysa dolar) - `docker compose up -d`. */
describe("triggerAlerts() - entegrasyon (gerçek Postgres + Mailpit)", () => {
  let db: Database;
  const suffix = Date.now();
  let userId = 0;
  let merchantId = 0;
  let priceDropProductId = 0;
  let restockProductId = 0;
  let restockOfferId = 0;
  let sizeProductId = 0;
  let sizeOfferId = 0;
  let sizeVariantId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `e2-trigger-${suffix}@example.test`,
      ]);
      userId = Number(user.rows[0].id);

      const merchant = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'Trigger Test Merchant', $2, 'xml_feed') RETURNING id`,
        [`e2-trigger-merchant-${suffix}`, `e2-trigger-${suffix}.test`],
      );
      merchantId = Number(merchant.rows[0].id);

      const makeProduct = async (title: string) => {
        const result = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`e2-trigger-${title}-${suffix}`, title],
        );
        return Number(result.rows[0].id);
      };
      priceDropProductId = await makeProduct("price-drop-urun");
      restockProductId = await makeProduct("restock-urun");
      sizeProductId = await makeProduct("size-restock-urun");

      const makeOffer = async (
        externalId: string,
        productId: number,
        currentPrice: number | null,
        inStock: boolean,
      ) => {
        const result = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
           VALUES ($1, $2, $3, $4, 'Trigger Teklif', $5, $6) RETURNING id`,
          [
            merchantId,
            productId,
            externalId,
            `https://e2-trigger.test/${externalId}`,
            currentPrice,
            inStock,
          ],
        );
        return Number(result.rows[0].id);
      };
      await makeOffer(`price-${suffix}`, priceDropProductId, 9000, true);
      restockOfferId = await makeOffer(`restock-${suffix}`, restockProductId, 5000, false);
      sizeOfferId = await makeOffer(`size-${suffix}`, sizeProductId, 5000, true);

      const variant = await client.query(
        `INSERT INTO offer_variant (offer_id, external_id, size_norm, in_stock)
         VALUES ($1, $2, '42', false) RETURNING id`,
        [sizeOfferId, `variant-${suffix}`],
      );
      sizeVariantId = Number(variant.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM alert WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM offer_variant WHERE id = $1", [sizeVariantId]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [
        [priceDropProductId, restockProductId, sizeProductId],
      ]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
    });
  });

  it("hedef fiyatin altina inen price_drop alarmini tetikler ve bildirir", async () => {
    const { alertId } = await createAlert(db, {
      userId,
      productId: priceDropProductId,
      kind: "price_drop",
      targetPrice: 10_000,
    });

    const result = await triggerAlerts(db);
    expect(result.triggeredCount).toBeGreaterThanOrEqual(1);
    expect(result.notifiedCount).toBeGreaterThanOrEqual(1);

    const row = await withOwnerClient((client) =>
      client.query("SELECT is_active, triggered_at, notified_at FROM alert WHERE id = $1", [
        alertId,
      ]),
    );
    expect(row.rows[0].is_active).toBe(false);
    expect(row.rows[0].triggered_at).not.toBeNull();
    expect(row.rows[0].notified_at).not.toBeNull();

    // Ikinci kosu ayni alarmi tekrar tetiklememeli (is_active zaten false).
    await triggerAlerts(db);
    const stillOne = await withOwnerClient((client) =>
      client.query("SELECT notified_at FROM alert WHERE id = $1", [alertId]),
    );
    expect(stillOne.rows[0].notified_at).toEqual(row.rows[0].notified_at);
  });

  it("stokta olmayan urun icin restock alarmini tetiklemez, stoga girince tetikler", async () => {
    const { alertId } = await createAlert(db, {
      userId,
      productId: restockProductId,
      kind: "restock",
    });

    await triggerAlerts(db);
    const beforeRow = await withOwnerClient((client) =>
      client.query("SELECT is_active FROM alert WHERE id = $1", [alertId]),
    );
    expect(beforeRow.rows[0].is_active).toBe(true);

    await withOwnerClient((client) =>
      client.query("UPDATE offer SET in_stock = true WHERE id = $1", [restockOfferId]),
    );

    await triggerAlerts(db);
    const afterRow = await withOwnerClient((client) =>
      client.query("SELECT is_active, notified_at FROM alert WHERE id = $1", [alertId]),
    );
    expect(afterRow.rows[0].is_active).toBe(false);
    expect(afterRow.rows[0].notified_at).not.toBeNull();
  });

  it("beden stoga girince size_restock alarmini tetikler", async () => {
    const { alertId } = await createAlert(db, {
      userId,
      productId: sizeProductId,
      kind: "size_restock",
      sizeNorm: "42",
    });

    await triggerAlerts(db);
    const beforeRow = await withOwnerClient((client) =>
      client.query("SELECT is_active FROM alert WHERE id = $1", [alertId]),
    );
    expect(beforeRow.rows[0].is_active).toBe(true);

    await withOwnerClient((client) =>
      client.query("UPDATE offer_variant SET in_stock = true WHERE id = $1", [sizeVariantId]),
    );

    await triggerAlerts(db);
    const afterRow = await withOwnerClient((client) =>
      client.query("SELECT is_active, notified_at FROM alert WHERE id = $1", [alertId]),
    );
    expect(afterRow.rows[0].is_active).toBe(false);
    expect(afterRow.rows[0].notified_at).not.toBeNull();
  });
});
