/**
 * Giriş akışı web sınırı (P1): e-posta bağlantısı GET'te tüketilmez,
 * yalnızca onay formunun POST'unda tüketilir; giriş sonrası `next` yalnızca
 * güvenli göreli yola gider. Gerçek yerel Postgres ve Redis; `next/headers`
 * ve `next/navigation` taklit edilir. Uzak adres görülürse test durur.
 */
import { DevSmsSender, generateRawToken, hashToken, requestPhoneLoginCode } from "@arilla/core";
import { createDatabase, getDatabase } from "@arilla/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { afterOnboarding } from "../onboarding-test-util.ts";

interface StoredCookie {
  value: string;
  options?: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  cookies: new Map<string, StoredCookie>(),
  headers: new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.77" }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const cookie = state.cookies.get(name);
      return cookie ? { name, value: cookie.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      state.cookies.set(name, { value, options });
    },
    delete: (arg: string | { name: string }) => {
      state.cookies.delete(typeof arg === "string" ? arg : arg.name);
    },
  }),
  headers: async () => state.headers,
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

async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
}

const suffix = Date.now();
const EMAIL = `p1-flow-${suffix}@test.local`;
const PHONE = `+90555${String(suffix).slice(-7)}`;

async function insertToken(options: { expired?: boolean } = {}): Promise<string> {
  const raw = generateRawToken();
  await owner((client) =>
    client.query(
      `INSERT INTO auth_token (email, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [EMAIL, hashToken(raw), options.expired ? "-5" : "15"],
    ),
  );
  return raw;
}

async function consumedAt(raw: string): Promise<Date | null> {
  return owner(async (client) => {
    const res = await client.query("SELECT consumed_at FROM auth_token WHERE token_hash = $1", [
      hashToken(raw),
    ]);
    return res.rows[0]?.consumed_at ?? null;
  });
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeAll(() => {
  // P1 davranışı (güvenli next) ürüne erişebilen kullanıcı içindir; ürün
  // kapalıyken yönlendirme early-access-gate.integration.test.ts içinde.
  vi.stubEnv("PRODUCT_ACCESS", "open");
  assertLocal("DATABASE_URL");
});

beforeEach(() => {
  state.cookies.clear();
});

afterAll(async () => {
  await owner(async (client) => {
    const ids = `SELECT user_id FROM user_identity WHERE provider = 'phone' AND provider_subject = $1`;
    await client.query(`DELETE FROM app_user WHERE id IN (${ids})`, [PHONE]);
    await client.query("DELETE FROM app_user WHERE email = $1", [EMAIL]);
    await client.query("DELETE FROM auth_token WHERE email = $1", [EMAIL]);
    await client.query("DELETE FROM phone_login_code WHERE phone = $1", [PHONE]);
  });
  await ownerPool?.end();
  vi.unstubAllEnvs();
});

describe("e-posta bağlantısı: GET onay, POST tüketim", () => {
  it("GET (tarayıcı/önizleme) token'ı tüketmez ve oturum açmaz", async () => {
    const raw = await insertToken();
    const { default: DogrulaPage } = await import("./dogrula/page.tsx");

    // Aynı bağlantı birkaç kez açılsa da (e-posta tarayıcısı + kullanıcı).
    await DogrulaPage({ searchParams: Promise.resolve({ token: raw, next: "/alarmlar" }) });
    await DogrulaPage({ searchParams: Promise.resolve({ token: raw }) });

    expect(await consumedAt(raw)).toBeNull();
    expect(state.cookies.has("session")).toBe(false);
  });

  it("POST token'ı tüketir, oturum çerezi yazar ve güvenli next'e yönlendirir", async () => {
    const raw = await insertToken();
    const { confirmLoginAction } = await import("./dogrula/actions.ts");

    const to = await redirectOf(() =>
      confirmLoginAction(form({ token: raw, next: "/alarmlar?sekme=aktif" })),
    );

    expect(afterOnboarding(to)).toBe("/alarmlar?sekme=aktif");
    expect(await consumedAt(raw)).not.toBeNull();
    const session = state.cookies.get("session");
    expect(session?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("aynı bağlantı ikinci kez kullanılamaz (replay)", async () => {
    const raw = await insertToken();
    const { confirmLoginAction } = await import("./dogrula/actions.ts");
    await redirectOf(() => confirmLoginAction(form({ token: raw })));
    state.cookies.clear();

    const to = await redirectOf(() => confirmLoginAction(form({ token: raw, next: "/alarmlar" })));

    expect(to).toBe("/giris?next=%2Falarmlar&error=used");
    expect(state.cookies.has("session")).toBe(false);
  });

  it("süresi dolmuş bağlantı expired hatasına düşer", async () => {
    const raw = await insertToken({ expired: true });
    const { confirmLoginAction } = await import("./dogrula/actions.ts");
    expect(await redirectOf(() => confirmLoginAction(form({ token: raw })))).toBe(
      "/giris?error=expired",
    );
  });

  it.each(["https://evil.example/", "//evil.example", "/\\evil.example"])(
    "dış adrese yönlendirmez: %s",
    async (next) => {
      const raw = await insertToken();
      const { confirmLoginAction } = await import("./dogrula/actions.ts");
      expect(
        afterOnboarding(await redirectOf(() => confirmLoginAction(form({ token: raw, next })))),
      ).toBe("/");
    },
  );
});

describe("next çerezi (Google / Apple / telefon)", () => {
  it("güvenli yolu saklar, okurken siler; güvensiz yolu saklamaz", async () => {
    const { rememberAuthNext, takeAuthNext, AUTH_NEXT_COOKIE } = await import("./next-cookie.ts");
    const { cookies } = await import("next/headers");
    const store = await cookies();

    rememberAuthNext(store, "/kaydettiklerim");
    expect(state.cookies.get(AUTH_NEXT_COOKIE)?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      path: "/giris",
    });
    expect(takeAuthNext(store)).toBe("/kaydettiklerim");
    expect(state.cookies.has(AUTH_NEXT_COOKIE)).toBe(false);

    rememberAuthNext(store, "//evil.example");
    expect(state.cookies.has(AUTH_NEXT_COOKIE)).toBe(false);

    // Çerez elle değiştirilse de okurken yeniden süzülür.
    state.cookies.set(AUTH_NEXT_COOKIE, { value: "https://evil.example" });
    expect(takeAuthNext(store)).toBe("/");
  });

  it("telefon doğrulaması başarılıysa next'e döner", async () => {
    await requestPhoneLoginCode(getDatabase(), { phone: PHONE, ip: null }, new DevSmsSender(), {
      checkRateLimit: async () => undefined,
      generateCode: () => "246810",
    });
    const { AUTH_NEXT_COOKIE } = await import("./next-cookie.ts");
    state.cookies.set("phone_login", { value: PHONE });
    state.cookies.set(AUTH_NEXT_COOKIE, { value: "/gecmis" });
    const { POST } = await import("./telefon/dogrula/route.ts");

    const response = await POST(
      new Request("http://localhost:3000/giris/telefon/dogrula", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
        body: form({ code: "246810" }),
      }),
    );

    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location") ?? "");
    expect(afterOnboarding(target.pathname + target.search)).toBe("/gecmis");
    expect(state.cookies.has("session")).toBe(true);
    expect(state.cookies.has(AUTH_NEXT_COOKIE)).toBe(false);
  });
});

describe("proxy: girişsiz korumalı sayfa", () => {
  it("dönüş yolunu next ile /giris'e taşır", async () => {
    const { proxy } = await import("../../proxy.ts");
    const response = proxy(new NextRequest("http://localhost:3000/alarmlar?sekme=aktif"));
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/giris");
    expect(location.searchParams.get("next")).toBe("/alarmlar?sekme=aktif");
  });
});
