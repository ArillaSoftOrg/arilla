/**
 * `/iletisim` server action'ı (docs/decisions/0061): gerçek oturum
 * doğrulaması, gerçek yerel Postgres ve Redis. Yalnızca `next/headers`
 * (çerez + başlık) taklit edilir. Her senaryo kendi IP'sini kullanır.
 * Yalnızca yerel veritabanında çalışır (uzak adres görülürse durur).
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  ip: "192.0.2.20",
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
  headers: async () => new Headers({ "x-forwarded-for": state.ip }),
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
const EMAIL = `contact-web-${suffix}@test.local`;
const OTHER_EMAIL = `contact-web-other-${suffix}@test.local`;
const SUBJECT = `ct-web-${suffix}`;
const sessionToken = generateRawToken();
let userId = 0;
let otherUserId = 0;

function form(subject: string, extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("name", "Ece Demir");
  data.set("email", "ece@test.local");
  data.set("category", "account");
  data.set("subject", `${SUBJECT} ${subject}`);
  data.set("message", "Telefonla giriş yaptığımda kod gelmiyor, yardımcı olur musunuz?");
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return data;
}

async function rowsWithSubject(subject: string) {
  return owner(async (client) => {
    const res = await client.query(
      "SELECT kind, user_id, name, email, category, source FROM feedback WHERE title = $1",
      [`${SUBJECT} ${subject}`],
    );
    return res.rows.map((row) => ({
      ...row,
      user_id: row.user_id === null ? null : Number(row.user_id),
    }));
  });
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email) VALUES ($1), ($2) RETURNING id, email",
      [EMAIL, OTHER_EMAIL],
    );
    for (const row of res.rows) {
      if (row.email === EMAIL) userId = Number(row.id);
      else otherUserId = Number(row.id);
    }
    await client.query(
      "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [userId, hashToken(sessionToken)],
    );
  });
});

let ipCounter = 0;
beforeEach(() => {
  state.token = undefined;
  state.ip = `2001:db8::c0:${(suffix % 0xffff).toString(16)}:${(++ipCounter).toString(16)}`;
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM feedback WHERE title LIKE $1", [`${SUBJECT}%`]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userId, otherUserId]]);
  });
  await ownerPool?.end();
});

describe("submitContactAction", () => {
  it("anonim: kind=contact, ad ve e-posta formdan, source public", async () => {
    const { submitContactAction } = await import("./actions.ts");
    expect(await submitContactAction(false, form("anonim"))).toEqual({ status: "ok" });
    expect(await rowsWithSubject("anonim")).toEqual([
      {
        kind: "contact",
        user_id: null,
        name: "Ece Demir",
        email: "ece@test.local",
        category: "account",
        source: "public",
      },
    ]);
  });

  it("girişli: hesap oturumdan; yanıt adresi formdaki e-posta", async () => {
    const { submitContactAction } = await import("./actions.ts");
    state.token = sessionToken;
    expect(await submitContactAction(true, form("girisli", { email: "yanit@test.local" }))).toEqual(
      { status: "ok" },
    );
    expect(await rowsWithSubject("girisli")).toEqual([
      expect.objectContaining({
        user_id: userId,
        email: "yanit@test.local",
        source: "early_access",
      }),
    ]);
  });

  it("istemcinin user_id alanı kabul edilmez; başka hesaba bağlanamaz", async () => {
    const { submitContactAction } = await import("./actions.ts");
    const result = await submitContactAction(
      false,
      form("sahte", { user_id: String(otherUserId) }),
    );
    expect(result).toMatchObject({ status: "invalid", formError: "malformed" });
    expect(await rowsWithSubject("sahte")).toEqual([]);
  });

  it("eksik ve geçersiz alanlar alan hatası döner, satır yazılmaz", async () => {
    const { submitContactAction } = await import("./actions.ts");
    const data = form("gecersiz", { email: "posta", category: "ux", message: "kısa" });
    data.delete("name");
    expect(await submitContactAction(false, data)).toEqual({
      status: "invalid",
      fieldErrors: {
        name: "required",
        email: "invalid",
        category: "invalid",
        message: "too_short",
      },
    });
    expect(await rowsWithSubject("gecersiz")).toEqual([]);
  });

  it("oturum sayfa açıkken düştüyse anonim yazılmaz", async () => {
    const { submitContactAction } = await import("./actions.ts");
    state.token = generateRawToken();
    expect(await submitContactAction(true, form("dusmus"))).toEqual({
      status: "session_expired",
    });
    expect(await rowsWithSubject("dusmus")).toEqual([]);
  });

  it("aynı IP'den 10 dakikada 5 gönderimden sonra sınırlanır (geri bildirimle ortak kota)", async () => {
    const { submitContactAction } = await import("./actions.ts");
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await submitContactAction(false, form(`limit-${i}`))).status);
    }
    expect(statuses).toEqual(["ok", "ok", "ok", "ok", "ok", "rate_limited"]);
  });
});
