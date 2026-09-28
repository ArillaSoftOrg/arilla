/**
 * Çıkış: bu cihazın oturumu veritabanından silinir, çerez temizlenir,
 * yönlendirme sabit `/`. Diğer cihazların oturumu etkilenmez.
 * Yalnızca yerel veritabanında çalışır (uzak adres görülürse durur).
 */
import { generateRawToken, hashToken, verifySessionToken } from "@arilla/core";
import { createDatabase, getDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  deleted: [] as { name: string; path?: string }[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
    delete: (cookie: { name: string; path?: string }) => {
      state.deleted.push(cookie);
    },
  }),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
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
let userId = 0;
const thisDevice = generateRawToken();
const otherDevice = generateRawToken();

async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    const res = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `logout-${suffix}@test.local`,
    ]);
    userId = Number(res.rows[0].id);
    for (const token of [thisDevice, otherDevice]) {
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [userId, hashToken(token)],
      );
    }
  });
});

afterAll(async () => {
  await owner((client) => client.query("DELETE FROM app_user WHERE id = $1", [userId]));
  await ownerPool?.end();
});

describe("logoutAction", () => {
  it("bu cihazın oturumunu siler, çerezi temizler ve / adresine yönlendirir", async () => {
    const { logoutAction } = await import("./cikis-actions.ts");
    state.token = thisDevice;
    state.deleted = [];

    expect(await redirectOf(logoutAction)).toBe("/");

    expect(await verifySessionToken(getDatabase(), thisDevice)).toBeNull();
    expect(state.deleted).toEqual([{ name: "session", path: "/" }]);
    // Diğer cihaz açık kalır.
    expect((await verifySessionToken(getDatabase(), otherDevice))?.id).toBe(userId);
  });

  it("oturum çerezi yoksa da güvenle çıkar", async () => {
    const { logoutAction } = await import("./cikis-actions.ts");
    state.token = undefined;
    state.deleted = [];

    expect(await redirectOf(logoutAction)).toBe("/");
    expect(state.deleted).toEqual([{ name: "session", path: "/" }]);
  });
});
