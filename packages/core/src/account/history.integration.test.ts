import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { clearHistory, listHistory, PRODUCT_VIEW_RETENTION, recordProductView } from "./history.ts";

describe("history - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let userId = 0;
  let otherUserId = 0;
  let noConsentUserId = 0;
  const productIds: number[] = [];

  async function setConsent(user: number, granted: boolean, at?: Date): Promise<void> {
    await withOwnerClient(async (client) => {
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted, granted_at) VALUES ($1, 'browsing_history', $2, $3)",
        [user, granted, at ?? new Date()],
      );
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const make = async (label: string) =>
        Number(
          (
            await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
              `e2-history-${label}-${suffix}@example.test`,
            ])
          ).rows[0].id,
        );
      userId = await make("a");
      otherUserId = await make("b");
      noConsentUserId = await make("c");
      for (let i = 0; i < PRODUCT_VIEW_RETENTION + 3; i++) {
        const prod = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`e2-history-product-${i}-${suffix}`, `Geçmiş Test Ürünü ${i}`],
        );
        productIds.push(Number(prod.rows[0].id));
      }
    });
    await setConsent(userId, true);
    await setConsent(otherUserId, true);
    await setConsent(noConsentUserId, false);
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      const users = [userId, otherUserId, noConsentUserId];
      await client.query("DELETE FROM product_view WHERE user_id = ANY($1)", [users]);
      await client.query("DELETE FROM user_consent WHERE user_id = ANY($1)", [users]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [users]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
    });
  });

  it("bos durumda liste bos doner", async () => {
    expect(await listHistory(db, userId)).toEqual([]);
  });

  it("görüntülenen ürün listeye yazılır, en yeni başta; tekrar görüntüleme öne alır (kopya yok)", async () => {
    const [a, b, c] = productIds as [number, number, number];
    const t0 = Date.now();
    expect(await recordProductView(db, { userId, productId: a, now: new Date(t0) })).toBe(
      "recorded",
    );
    await recordProductView(db, { userId, productId: b, now: new Date(t0 + 1000) });
    await recordProductView(db, { userId, productId: c, now: new Date(t0 + 2000) });
    expect((await listHistory(db, userId)).map((i) => i.productId)).toEqual([c, b, a]);

    await recordProductView(db, { userId, productId: a, now: new Date(t0 + 3000) });
    const list = await listHistory(db, userId);
    expect(list.map((i) => i.productId)).toEqual([a, c, b]);
    expect(list).toHaveLength(3);
  });

  it("kullanıcılar birbirinin geçmişini görmez", async () => {
    const [, , c] = productIds as [number, number, number];
    await recordProductView(db, { userId: otherUserId, productId: c });
    expect((await listHistory(db, otherUserId)).map((i) => i.productId)).toEqual([c]);
    expect((await listHistory(db, userId)).map((i) => i.productId)).toContain(c);
    expect(await listHistory(db, noConsentUserId)).toEqual([]);
  });

  it("rıza yoksa, geri çekildiyse ya da kullanıcı yoksa hiçbir şey yazılmaz", async () => {
    const p = productIds[0] as number;
    expect(await recordProductView(db, { userId: noConsentUserId, productId: p })).toBe(
      "no_consent",
    );
    expect(await recordProductView(db, { userId: null, productId: p })).toBe("no_user");
    expect(await recordProductView(db, { userId: undefined, productId: p })).toBe("no_user");
    expect(await listHistory(db, noConsentUserId)).toEqual([]);

    // Geri çekme: son karar `false` ise yazılmaz.
    await setConsent(otherUserId, false, new Date(Date.now() + 5000));
    expect(
      await recordProductView(db, { userId: otherUserId, productId: productIds[1] as number }),
    ).toBe("no_consent");
  });

  it(`kullanıcı başına en fazla ${PRODUCT_VIEW_RETENTION} kayıt tutulur`, async () => {
    await clearHistory(db, userId);
    const t0 = Date.now();
    for (let i = 0; i < productIds.length; i++) {
      await recordProductView(db, {
        userId,
        productId: productIds[i] as number,
        now: new Date(t0 + i * 1000),
      });
    }
    const list = await listHistory(db, userId, 100);
    expect(list).toHaveLength(PRODUCT_VIEW_RETENTION);
    expect(list[0]?.productId).toBe(productIds[productIds.length - 1]);
    expect(list.map((i) => i.productId)).not.toContain(productIds[0]);
  });

  it("listeler ve gerçekten siler", async () => {
    expect((await listHistory(db, userId)).length).toBeGreaterThan(0);
    await clearHistory(db, userId);
    expect(await listHistory(db, userId)).toHaveLength(0);
  });
});
