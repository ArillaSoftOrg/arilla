/**
 * `/geri-bildirim` server action'ı: gerçek oturum doğrulaması, gerçek yerel
 * Postgres ve Redis. Yalnızca `next/headers` (çerez + başlık) taklit edilir.
 * Oran sınırı anahtarları kullanıcı/IP başına: her senaryo kendi
 * kullanıcısını ve IP'sini kullanır, sayaçlar 10 dakikada kendiliğinden düşer.
 * Yalnızca yerel veritabanında çalışır (uzak adres görülürse durur).
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  ip: "192.0.2.10",
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
const EMAIL = `feedback-web-${suffix}@test.local`;
const OTHER_EMAIL = `feedback-web-other-${suffix}@test.local`;
const TITLE = `fb-web-${suffix}`;
const sessionToken = generateRawToken();
const limitToken = generateRawToken();
let userId = 0;
let otherUserId = 0;
let limitUserId = 0;

function form(title: string, extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("category", "ux");
  data.set("title", `${TITLE} ${title}`);
  data.set("message", "Mobilde filtre paneli ekranın altında kayboluyor.");
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return data;
}

async function rowsWithTitle(title: string) {
  return owner(async (client) => {
    const res = await client.query("SELECT user_id, email, source FROM feedback WHERE title = $1", [
      `${TITLE} ${title}`,
    ]);
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
      "INSERT INTO app_user (email) VALUES ($1), ($2), ($3) RETURNING id, email",
      [EMAIL, OTHER_EMAIL, `limit-${EMAIL}`],
    );
    for (const row of res.rows) {
      if (row.email === EMAIL) userId = Number(row.id);
      else if (row.email === OTHER_EMAIL) otherUserId = Number(row.id);
      else limitUserId = Number(row.id);
    }
    for (const [id, token] of [
      [userId, sessionToken],
      [limitUserId, limitToken],
    ] as const) {
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, hashToken(token)],
      );
    }
  });
});

let ipCounter = 0;
beforeEach(() => {
  state.token = undefined;
  // Her senaryoya ayrı anonim IP (IPv6 belgeleme aralığı, koşu başına benzersiz).
  state.ip = `2001:db8::${(suffix % 0xffff).toString(16)}:${(++ipCounter).toString(16)}`;
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM feedback WHERE title LIKE $1", [`${TITLE}%`]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
      [userId, otherUserId, limitUserId],
    ]);
  });
  await ownerPool?.end();
});

describe("submitFeedbackAction", () => {
  it("anonim: user_id NULL, source public, e-posta isteğe bağlı", async () => {
    const { submitFeedbackAction } = await import("./actions.ts");
    expect(await submitFeedbackAction(false, form("anonim"))).toEqual({ status: "ok" });
    expect(await rowsWithTitle("anonim")).toEqual([
      { user_id: null, email: null, source: "public" },
    ]);
  });

  it("girişli: kimlik oturumdan, hesap e-postası kullanılır", async () => {
    const { submitFeedbackAction } = await import("./actions.ts");
    state.token = sessionToken;
    expect(await submitFeedbackAction(true, form("girisli", { email: OTHER_EMAIL }))).toEqual({
      status: "ok",
    });
    expect(await rowsWithTitle("girisli")).toEqual([
      { user_id: userId, email: EMAIL, source: "early_access" },
    ]);
  });

  it("istemcinin user_id alanı kabul edilmez; başka kullanıcıya bağlanamaz", async () => {
    const { submitFeedbackAction } = await import("./actions.ts");
    state.token = sessionToken;
    const result = await submitFeedbackAction(
      true,
      form("sahte", { user_id: String(otherUserId) }),
    );
    expect(result).toMatchObject({ status: "invalid", formError: "malformed" });
    expect(await rowsWithTitle("sahte")).toEqual([]);
  });

  it("geçersiz alanlar alan hatası döner", async () => {
    const { submitFeedbackAction } = await import("./actions.ts");
    const data = form("gecersiz", { category: "spam", email: "posta", message: "kısa" });
    data.set("title", "a");
    expect(await submitFeedbackAction(false, data)).toEqual({
      status: "invalid",
      fieldErrors: {
        category: "invalid",
        title: "too_short",
        message: "too_short",
        email: "invalid",
      },
    });
  });

  it("oturum sayfa açıkken düştüyse anonim yazılmaz", async () => {
    const { submitFeedbackAction } = await import("./actions.ts");
    state.token = generateRawToken(); // geçersiz / süresi dolmuş oturum
    expect(await submitFeedbackAction(true, form("dusmus"))).toEqual({
      status: "session_expired",
    });
    expect(await rowsWithTitle("dusmus")).toEqual([]);
  });

  it("girişli kullanıcı 10 dakikada 5 gönderimden sonra sınırlanır", async () => {
    const { submitFeedbackAction } = await import("./actions.ts");
    state.token = limitToken;
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      state.ip = `2001:db8::ffff:${i + 1}`; // IP değişse de hesap anahtarı aynı
      statuses.push((await submitFeedbackAction(true, form(`limit-${i}`))).status);
    }
    expect(statuses).toEqual(["ok", "ok", "ok", "ok", "ok", "rate_limited"]);
  });
});
