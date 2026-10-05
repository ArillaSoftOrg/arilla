/**
 * `/giris/google` ve `/giris/google/callback` route'lari - gercek yerel
 * Postgres, sahte Google (`fetch` taklit). Kullanici her hatada ayni genel
 * mesaja duser; sunucu logu ayirt edilebilir ve gizli deger icermez.
 */
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { afterOnboarding } from "../../onboarding-test-util.ts";

const state = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

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
  headers: async () => new Headers({ "user-agent": "vitest" }),
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

async function redirectOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error("yönlendirme bekleniyordu");
}

const suffix = Date.now();
const USER_EMAIL = `gcb-user-${suffix}@example.test`;
const ADMIN_EMAIL = `gcb-admin-${suffix}@example.test`;
const SECRET = "test-client-secret-value";
let errors: string[] = [];

function stubGoogle(profile: { sub: string; email: string }, tokenStatus = 200) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return tokenStatus === 200
        ? Response.json({ access_token: "fake-access" })
        : Response.json({ error: "invalid_client" }, { status: tokenStatus });
    }
    return Response.json({ ...profile, email_verified: true });
  });
  return calls;
}

async function startThenCallback(next: string | null, profile: { sub: string; email: string }) {
  const { GET: start } = await import("./route.ts");
  const startUrl = `http://localhost:3000/giris/google${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  const authorize = new URL(await redirectOf(() => start(new Request(startUrl))));
  const stateParam = authorize.searchParams.get("state") ?? "";
  const calls = stubGoogle(profile);
  const { GET: callback } = await import("./callback/route.ts");
  const to = await redirectOf(() =>
    callback(
      new Request(`http://localhost:3000/giris/google/callback?code=fake-code&state=${stateParam}`),
    ),
  );
  return { authorize, to, calls };
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner((client) =>
    client.query("INSERT INTO app_user (email, role) VALUES ($1, 'admin')", [ADMIN_EMAIL]),
  );
});

beforeEach(() => {
  state.cookies.clear();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  vi.stubEnv("GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", SECRET);
  vi.stubEnv("PRODUCT_ACCESS", "");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await owner(async (client) => {
    await client.query("DELETE FROM app_user WHERE email = ANY($1)", [[USER_EMAIL, ADMIN_EMAIL]]);
  });
  await ownerPool?.end();
});

describe("Google callback", () => {
  it("geçerli callback: authorize ve token aynı redirect_uri; oturum; normal kullanıcı başarı ekranına", async () => {
    const { authorize, to, calls } = await startThenCallback("/alarmlar", {
      sub: `gcb-sub-user-${suffix}`,
      email: USER_EMAIL,
    });
    const tokenBody = new URLSearchParams(calls[0]?.body);
    expect(tokenBody.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"));
    expect(afterOnboarding(to)).toBe("/erken-erisim");
    expect(state.cookies.has("session")).toBe(true);
    expect(state.cookies.has("google_oauth_state")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("yönetici güvenli next'e döner; dış adres next'i düşer", async () => {
    const safe = await startThenCallback("/yonetim/magazalar", {
      sub: `gcb-sub-admin-${suffix}`,
      email: ADMIN_EMAIL,
    });
    expect(safe.to).toBe("/yonetim/magazalar");
    state.cookies.clear();
    const unsafe = await startThenCallback("//evil.example", {
      sub: `gcb-sub-admin-${suffix}`,
      email: ADMIN_EMAIL,
    });
    expect(unsafe.to).toBe("/");
  });

  it.each([
    ["state çerezi yok", "code=c&state=s", false, "state_missing"],
    ["state uyuşmuyor", "code=c&state=baska", true, "state_mismatch"],
    ["kullanıcı reddetti", "error=access_denied&state=s", true, "provider:access_denied"],
    ["code yok", "state=s", true, "code_missing"],
  ])("%s → genel mesaj + %s logu", async (_label, query, withCookie, category) => {
    if (withCookie) state.cookies.set("google_oauth_state", "s");
    const { GET } = await import("./callback/route.ts");
    const to = await redirectOf(() =>
      GET(new Request(`http://localhost:3000/giris/google/callback?${query}`)),
    );
    expect(to).toBe("/giris?error=google");
    expect(errors).toEqual([`[giris] google oauth rejected: ${category}`]);
    expect(state.cookies.has("session")).toBe(false);
  });

  it("token değişimi başarısız → genel mesaj, log kategori taşır ama secret/code taşımaz", async () => {
    state.cookies.set("google_oauth_state", "s");
    stubGoogle({ sub: "x", email: "x@example.test" }, 401);
    const { GET } = await import("./callback/route.ts");
    const to = await redirectOf(() =>
      GET(new Request("http://localhost:3000/giris/google/callback?code=secret-code&state=s")),
    );
    expect(to).toBe("/giris?error=google");
    expect(errors).toEqual(["[giris] google oauth failed: token:http_401:invalid_client"]);
    expect(errors.join()).not.toContain(SECRET);
    expect(errors.join()).not.toContain("secret-code");
  });

  it("yapılandırma eksikse Google'a hiç gidilmez", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const { GET } = await import("./route.ts");
    expect(await redirectOf(() => GET(new Request("http://localhost:3000/giris/google")))).toBe(
      "/giris?error=google",
    );
    expect(errors).toEqual([
      "[giris] google oauth not started: config_missing:GOOGLE_CLIENT_SECRET",
    ]);
  });
});
