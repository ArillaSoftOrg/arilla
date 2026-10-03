/**
 * docs/decisions/0049 web sınırı: giriş sonrası giriş geçmişi + kaba bağlam
 * + rıza senkronu; girişli kullanıcının çerez kararının hesaba yazılması ve
 * analitik geri alması; `/git` çıkışında attribution (`click.user_id`) ile
 * rızalı analitik (`merchant_exit`) ayrımı. Gerçek yerel Postgres;
 * `next/headers` ve `next/navigation` taklit edilir. Uzak adres görülürse
 * test durur.
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { acceptAll, parseConsentCookie, serializeConsent } from "@arilla/core/cookie-consent";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      state.cookies.set(name, value);
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
  notFound: () => {
    throw new Error("notFound");
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

const suffix = `${Date.now()}`;
const EMAIL = `uac-web-${suffix}@test.local`;
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

let userId = 0;
let offerId = 0;

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  vi.stubEnv("PRODUCT_ACCESS", "open");
  const offers = await owner((client) =>
    client.query("SELECT id FROM offer WHERE product_id IS NOT NULL ORDER BY id LIMIT 1"),
  );
  offerId = Number(offers.rows[0]?.id);
  if (!offerId) throw new Error("seed'li offer yok - once `pnpm seed`");
});

beforeEach(() => {
  state.headers = new Headers({
    "user-agent": MOBILE_UA,
    "x-forwarded-for": "203.0.113.88",
    "x-vercel-ip-country": "TR",
  });
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("UPDATE click SET user_id = NULL WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM app_user WHERE email = $1", [EMAIL]);
    await client.query("DELETE FROM auth_token WHERE email = $1", [EMAIL]);
  });
  await ownerPool?.end();
  vi.unstubAllEnvs();
});

describe("giriş: geçmiş, kaba bağlam ve rıza senkronu", () => {
  it("e-posta girişi sign_up+sign_in yazar, IP/UA yeni tablolara girmez, çerez kararı hesaba aktarılır", async () => {
    const raw = generateRawToken();
    await owner((client) =>
      client.query(
        "INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
        [EMAIL, hashToken(raw)],
      ),
    );
    // Anonim ziyaretçi bantta "Tümünü kabul et" demiş.
    state.cookies.set("cookie_consent", serializeConsent(acceptAll(new Date(Date.now() - 60_000))));
    const { confirmLoginAction } = await import("./dogrula/actions.ts");
    const data = new FormData();
    data.set("token", raw);
    await redirectOf(() => confirmLoginAction(data));

    const users = await owner((client) =>
      client.query("SELECT id FROM app_user WHERE email = $1", [EMAIL]),
    );
    userId = Number(users.rows[0]?.id);
    expect(userId).toBeGreaterThan(0);

    const events = await owner((client) =>
      client.query(
        "SELECT kind, provider, device_class, browser_family, country_code FROM auth_event WHERE user_id = $1 ORDER BY id",
        [userId],
      ),
    );
    expect(events.rows.map((row) => row.kind)).toEqual(["sign_up", "sign_in"]);
    expect(events.rows[1]).toMatchObject({
      provider: "email",
      device_class: "mobile",
      browser_family: "chrome",
      country_code: "TR",
    });
    const flat = JSON.stringify(events.rows);
    expect(flat).not.toContain("203.0.113.88");
    expect(flat).not.toContain("Pixel");

    const consents = await owner((client) =>
      client.query(
        "SELECT kind, granted, source, text_version FROM user_consent WHERE user_id = $1 ORDER BY kind",
        [userId],
      ),
    );
    const byKind = Object.fromEntries(consents.rows.map((row) => [row.kind, row]));
    expect(byKind.cookie_analytics).toMatchObject({ granted: true, source: "cookie_sync" });
    expect(byKind.privacy_notice).toMatchObject({ granted: true, source: "sign_in" });
    expect(state.cookies.get("session")).toBeTruthy();
  });
});

describe("mağaza çıkışı: attribution ile analitik ayrı", () => {
  it("rıza varken click.user_id + merchant_exit; geri almadan sonra yalnızca click", async () => {
    const { GET } = await import("../git/[offerId]/route.ts");
    const call = () =>
      redirectOf(() =>
        GET(new Request(`http://localhost/git/${offerId}?surface=compare`), {
          params: Promise.resolve({ offerId: String(offerId) }),
        }),
      );

    expect(await call()).toBeTruthy();
    let exits = await owner((client) =>
      client.query(
        "SELECT count(*)::int AS n FROM user_activity_event WHERE user_id = $1 AND kind = 'merchant_exit'",
        [userId],
      ),
    );
    expect(exits.rows[0]?.n).toBe(1);

    // Girişli kullanıcı bantta "Tümünü reddet": hesap kaydı + analitik geçmişi silinir.
    const { rejectAllCookiesAction } = await import("../consent-actions.ts");
    await rejectAllCookiesAction();
    const latest = await owner((client) =>
      client.query(
        `SELECT granted, source FROM user_consent WHERE user_id = $1 AND kind = 'cookie_analytics'
          ORDER BY granted_at DESC, id DESC LIMIT 1`,
        [userId],
      ),
    );
    expect(latest.rows[0]).toMatchObject({ granted: false, source: "cookie_banner" });
    exits = await owner((client) =>
      client.query("SELECT count(*)::int AS n FROM user_activity_event WHERE user_id = $1", [
        userId,
      ]),
    );
    expect(exits.rows[0]?.n).toBe(0);
    expect(parseConsentCookie(state.cookies.get("cookie_consent"))?.analytics).toBe(false);

    expect(await call()).toBeTruthy();
    const clicks = await owner((client) =>
      client.query(
        "SELECT count(*)::int AS n, max(surface) AS surface FROM click WHERE user_id = $1",
        [userId],
      ),
    );
    expect(clicks.rows[0]?.n).toBe(2);
    expect(clicks.rows[0]?.surface).toBe("compare");
    exits = await owner((client) =>
      client.query("SELECT count(*)::int AS n FROM user_activity_event WHERE user_id = $1", [
        userId,
      ]),
    );
    expect(exits.rows[0]?.n).toBe(0);
  });
});
