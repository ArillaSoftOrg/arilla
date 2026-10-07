import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { clearHistory, HISTORY_MAX_ROWS, listHistory, recordProductView } from "./history.ts";

describe("recordProductView - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = `${Date.now()}-rv`;
  let userId = 0;
  let noConsentUserId = 0;
  const productIds: number[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const u = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `rv-a-${suffix}@example.test`,
      ]);
      userId = Number(u.rows[0].id);
      const n = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `rv-b-${suffix}@example.test`,
      ]);
      noConsentUserId = Number(n.rows[0].id);
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted) VALUES ($1, 'browsing_history', true)",
        [userId],
      );
      for (let i = 0; i < HISTORY_MAX_ROWS + 2; i++) {
        const p = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`rv-product-${suffix}-${i}`, `Görüntüleme Ürünü ${i}`],
        );
        productIds.push(Number(p.rows[0].id));
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM product_view WHERE user_id = ANY($1)", [
        [userId, noConsentUserId],
      ]);
      await client.query("DELETE FROM user_consent WHERE user_id = ANY($1)", [
        [userId, noConsentUserId],
      ]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userId, noConsentUserId]]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
    });
  });

  it("A, B sonra tekrar A: yeni görüntülenen başta, yineleme yok", async () => {
    const [a, b] = productIds as [number, number];
    const t0 = Date.now();
    expect(await recordProductView(db, { userId, productId: a, now: new Date(t0) })).toBe(
      "recorded",
    );
    await recordProductView(db, { userId, productId: b, now: new Date(t0 + 1000) });

    let list = await listHistory(db, userId);
    expect(list.map((i) => i.productId)).toEqual([b, a]);

    await recordProductView(db, { userId, productId: a, now: new Date(t0 + 2000) });
    list = await listHistory(db, userId);
    expect(list.map((i) => i.productId)).toEqual([a, b]);
    expect(list).toHaveLength(2);
  });

  it("eşzamanlı aynı ürün görüntülemeleri tek satır üretir; başka kullanıcıya dokunmaz", async () => {
    const d = productIds[5] as number;
    const before = (await listHistory(db, userId)).length;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordProductView(db, { userId, productId: d, now: new Date(Date.now() + i) }),
      ),
    );
    const list = await listHistory(db, userId);
    expect(list.filter((i) => i.productId === d)).toHaveLength(1);
    expect(list).toHaveLength(before + 1);
    expect(await listHistory(db, noConsentUserId)).toHaveLength(0);
  });

  it("rıza yoksa, kullanıcı yoksa ya da kimlik geçersizse yazmaz", async () => {
    const [a] = productIds as [number];
    expect(await recordProductView(db, { userId: noConsentUserId, productId: a })).toBe(
      "no_consent",
    );
    expect(await recordProductView(db, { userId: null, productId: a })).toBe("no_user");
    expect(await recordProductView(db, { userId, productId: 0 })).toBe("invalid");
    expect(await listHistory(db, noConsentUserId)).toHaveLength(0);
  });

  it("rıza geri çekilince yazmaz", async () => {
    const [, , c] = productIds as [number, number, number];
    await withOwnerClient(async (client) => {
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted, granted_at) VALUES ($1, 'browsing_history', false, now() + interval '1 second')",
        [userId],
      );
    });
    expect(await recordProductView(db, { userId, productId: c })).toBe("no_consent");
    expect((await listHistory(db, userId)).some((i) => i.productId === c)).toBe(false);
  });

  it("kullanıcı başına en fazla HISTORY_MAX_ROWS satır tutar", async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted, granted_at) VALUES ($1, 'browsing_history', true, now() + interval '2 seconds')",
        [userId],
      );
    });
    const base = Date.now() + 10_000;
    for (let i = 0; i < productIds.length; i++) {
      await recordProductView(db, {
        userId,
        productId: productIds[i] as number,
        now: new Date(base + i * 1000),
      });
    }
    const list = await listHistory(db, userId, 200);
    expect(list).toHaveLength(HISTORY_MAX_ROWS);
    expect(list[0]?.productId).toBe(productIds[productIds.length - 1]);
  });
});

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
