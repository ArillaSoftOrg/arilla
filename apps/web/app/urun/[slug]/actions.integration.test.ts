/**
 * Alarm oluşturma yetki sınırı: server action gövdesi istemciden gelir.
 * Tipte olmayan `userId` gönderilse bile alarm yalnızca oturumdaki
 * kullanıcıya yazılmalı (başka kullanıcı adına alarm = IDOR).
 * Yalnızca yerel veritabanında çalışır (uzak adres görülürse durur).
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type CreateAlertActionInput, createAlertAction } from "./actions.ts";

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
}));

function assertLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); bu test yalnızca yerel veritabanında çalışır.`);
  }
  return url;
}

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;

async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

const suffix = Date.now();
let attackerId = 0;
let victimId = 0;
let productId = 0;
let attackerToken = "";

async function alertOwners(): Promise<number[]> {
  return owner(async (client) => {
    const res = await client.query("SELECT user_id FROM alert WHERE product_id = $1", [productId]);
    return res.rows.map((row: { user_id: string }) => Number(row.user_id));
  });
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    const insertUser = async (label: string) => {
      const res = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `alert-idor-${label}-${suffix}@test.local`,
      ]);
      return Number(res.rows[0].id);
    };
    attackerId = await insertUser("attacker");
    victimId = await insertUser("victim");
    attackerToken = generateRawToken();
    await client.query(
      "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [attackerId, hashToken(attackerToken)],
    );
    const product = await client.query(
      "INSERT INTO product (slug, title) VALUES ($1, 'Alarm IDOR Ürün') RETURNING id",
      [`alert-idor-${suffix}`],
    );
    productId = Number(product.rows[0].id);
  });
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM alert WHERE product_id = $1", [productId]);
    await client.query("DELETE FROM product WHERE id = $1", [productId]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[attackerId, victimId]]);
  });
  await ownerPool?.end();
});

describe("createAlertAction", () => {
  it("oturum yoksa alarm yazmaz", async () => {
    state.token = undefined;
    expect(await createAlertAction({ productId, kind: "restock" })).toBe("unauthenticated");
    expect(await alertOwners()).toEqual([]);
  });

  it("istemciden gelen userId'yi yok sayar; alarm oturumdaki kullanıcıya yazılır", async () => {
    state.token = attackerToken;
    // Tipte olmayan alan, saldırganın çalışma anında gönderebileceği gövde.
    const forged = { productId, kind: "restock", userId: victimId } as CreateAlertActionInput;

    expect(await createAlertAction(forged)).toBe("ok");

    expect(await alertOwners()).toEqual([attackerId]);
  });

  it("başka kullanıcının alarmı hakkında bilgi sızdırmaz", async () => {
    await owner((client) =>
      client.query(
        "INSERT INTO alert (user_id, product_id, kind, target_price) VALUES ($1, $2, 'price_drop', 1000)",
        [victimId, productId],
      ),
    );
    state.token = attackerToken;
    const forged = {
      productId,
      kind: "price_drop",
      targetPrice: 1000,
      userId: victimId,
    } as CreateAlertActionInput;

    // Kurbanın aynı alarmı var; yanıt yine saldırganın kendi durumunu yansıtır.
    expect(await createAlertAction(forged)).toBe("ok");
    const owners = await alertOwners();
    expect(owners.filter((id) => id === victimId)).toHaveLength(1);
    expect(owners.filter((id) => id === attackerId)).toHaveLength(2);
  });

  it("mevcut davranış korunur: tekrar ve geçersiz girdi", async () => {
    state.token = attackerToken;
    expect(await createAlertAction({ productId, kind: "restock" })).toBe("already_exists");
    expect(await createAlertAction({ productId, kind: "price_drop" })).toBe("invalid");
  });
});
