/**
 * `/hesap` güvenlik eylemleri (karar 0050), gerçek yerel Postgres:
 * - "Tüm cihazlardan çıkış": bütün oturumlar silinir, başka hesaba dokunulmaz.
 * - Hesap silme: yetkili hesap silinemez (hiçbir şey değişmez, mesaj döner);
 *   normal hesap silinir, oturumu bir sonraki istekte geçersizdir.
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
  headers: async () => new Headers(),
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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

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
const ids: Record<string, number> = {};

async function createUser(key: string, role = "user"): Promise<number> {
  return owner(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
      [`hesap-${key}-${suffix}@test.local`, role],
    );
    ids[key] = Number(res.rows[0].id);
    return ids[key] as number;
  });
}

async function addSession(userId: number): Promise<string> {
  const raw = generateRawToken();
  await owner((client) =>
    client.query(
      "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [userId, hashToken(raw)],
    ),
  );
  return raw;
}

async function sessions(userId: number): Promise<number> {
  return owner(async (client) => {
    const res = await client.query("SELECT count(*)::int AS n FROM session WHERE user_id = $1", [
      userId,
    ]);
    return res.rows[0].n as number;
  });
}

async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
}

beforeAll(() => {
  assertLocal("DATABASE_URL");
});

afterAll(async () => {
  const all = Object.values(ids);
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [all]);
    await client.query(
      "DELETE FROM admin_audit_event WHERE target_type = 'app_user' AND target_id = ANY($1::text[])",
      [all.map(String)],
    );
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [all]);
  });
  await ownerPool?.end();
});

describe("tüm cihazlardan çıkış", () => {
  it("bu cihaz dahil bütün oturumları siler, çerezi temizler, başka hesaba dokunmaz", async () => {
    const { logoutAllDevicesAction } = await import("./actions.ts");
    const me = await createUser("all");
    const other = await createUser("other");
    const thisDevice = await addSession(me);
    const phone = await addSession(me);
    const otherDevice = await addSession(other);
    state.token = thisDevice;
    state.deleted = [];

    expect(await redirectOf(logoutAllDevicesAction)).toBe("/giris");
    expect(await sessions(me)).toBe(0);
    expect(await verifySessionToken(getDatabase(), phone)).toBeNull();
    expect(state.deleted).toEqual([{ name: "session", path: "/" }]);
    expect((await verifySessionToken(getDatabase(), otherDevice))?.id).toBe(other);
  });

  it("oturumsuz çağrı girişe gider, hiçbir şey silmez", async () => {
    const { logoutAllDevicesAction } = await import("./actions.ts");
    state.token = undefined;
    expect(await redirectOf(logoutAllDevicesAction)).toBe("/giris");
  });
});

describe("hesap silme", () => {
  it("yetkili hesap silinemez: mesaj döner, hesap ve oturum kalır", async () => {
    const { deleteAccountAction } = await import("./actions.ts");
    const admin = await createUser("staff", "admin");
    state.token = await addSession(admin);
    state.deleted = [];

    const result = await deleteAccountAction();
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("silinemez") });
    expect(state.deleted).toEqual([]);
    expect(await sessions(admin)).toBe(1);
  });

  it("normal hesap silinir; çalınmış çerez bir sonraki istekte geçersiz", async () => {
    const { deleteAccountAction } = await import("./actions.ts");
    const user = await createUser("plain");
    const token = await addSession(user);
    const otherDevice = await addSession(user);
    state.token = token;

    expect(await redirectOf(deleteAccountAction)).toBe("/");
    expect(await verifySessionToken(getDatabase(), otherDevice)).toBeNull();
    const exists = await owner(
      async (client) =>
        (await client.query("SELECT 1 FROM app_user WHERE id = $1", [user])).rowCount,
    );
    expect(exists).toBe(0);
  });
});
