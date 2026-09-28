/**
 * Apple ve telefon giriş route'ları + giriş ekranlarında sağlayıcı durumu -
 * gerçek yerel Postgres ve Redis; Apple ve Netgsm `fetch` taklidiyle.
 * Gerçek Apple isteği ya da SMS gönderilmez. Uzak adres görülürse durur.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createDatabase } from "@arilla/db";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

function location(response: Response): string {
  const url = new URL(response.headers.get("location") ?? "");
  return `${url.pathname}${url.search}`;
}

const suffix = Date.now();
const ADMIN_EMAIL = `ap-admin-${suffix}@example.test`;
const APPLE_CLIENT_ID = "com.manicepte.test.web";
let errors: string[] = [];

// Sahte Apple: client_secret için P-256, id_token için RSA anahtarı.
const ecKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = `web-kid-${suffix}`;
const JWK = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" };
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function appleIdToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "RS256", kid: KID })}.${b64({
    iss: "https://appleid.apple.com",
    aud: APPLE_CLIENT_ID,
    iat: now - 5,
    exp: now + 600,
    ...claims,
  })}`;
  return `${input}.${sign("sha256", Buffer.from(input), rsa.privateKey).toString("base64url")}`;
}

function stubApple(token: { status?: number; body: unknown }) {
  vi.stubGlobal("fetch", async (url: string | URL | Request) =>
    String(url).endsWith("/auth/keys")
      ? Response.json({ keys: [JWK] })
      : Response.json(token.body, { status: token.status ?? 200 }),
  );
}

function stubNetgsm(code: string) {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return Response.json({ code }, { status: code === "00" ? 200 : 406 });
  });
  return bodies;
}

function appleEnv() {
  vi.stubEnv("APPLE_CLIENT_ID", APPLE_CLIENT_ID);
  vi.stubEnv("APPLE_TEAM_ID", "TEAMID1234");
  vi.stubEnv("APPLE_KEY_ID", "KEYID12345");
  vi.stubEnv("APPLE_PRIVATE_KEY", ecKey);
}

function netgsmEnv() {
  vi.stubEnv("SMS_PROVIDER", "netgsm");
  vi.stubEnv("NETGSM_USERCODE", "8500000000");
  vi.stubEnv("NETGSM_PASSWORD", "test-only-password");
  vi.stubEnv("NETGSM_MSGHEADER", "MANICEPTE");
}

/** `/giris/apple` → state/nonce çerezleri; ardından Apple'ın form_post'u. */
async function appleRoundTrip(claims: Record<string, unknown>, next?: string) {
  const { GET } = await import("./apple/route.ts");
  const authorize = new URL(
    await redirectOf(() =>
      GET(
        new Request(
          `http://localhost:3000/giris/apple${next ? `?next=${encodeURIComponent(next)}` : ""}`,
        ),
      ),
    ),
  );
  const rawNonce = state.cookies.get("apple_oauth_nonce") ?? "";
  expect(authorize.searchParams.get("nonce")).toBe(
    createHash("sha256").update(rawNonce).digest("hex"),
  );
  stubApple({
    body: { id_token: appleIdToken({ nonce: authorize.searchParams.get("nonce"), ...claims }) },
  });
  const form = new FormData();
  form.set("code", "fake-code");
  form.set("state", authorize.searchParams.get("state") ?? "");
  const { POST } = await import("./apple/callback/route.ts");
  return {
    authorize,
    response: await POST(
      new Request("http://localhost:3000/giris/apple/callback", { method: "POST", body: form }),
    ),
  };
}

async function postPhone(path: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const { POST } = await import(`./telefon/${path}/route.ts`);
  return (await POST(
    new Request(`http://localhost:3000/giris/telefon/${path}`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
      body: form,
    }),
  )) as Response;
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner((c) =>
    c.query("INSERT INTO app_user (email, role) VALUES ($1, 'admin')", [ADMIN_EMAIL]),
  );
});

beforeEach(() => {
  state.cookies.clear();
  errors = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  vi.stubEnv("PRODUCT_ACCESS", "");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await owner(async (c) => {
    await c.query(
      `DELETE FROM app_user WHERE id IN (SELECT user_id FROM user_identity
         WHERE (provider = 'apple' AND provider_subject LIKE $1)
            OR (provider = 'phone' AND provider_subject LIKE $2))`,
      [`web-apple-%-${suffix}`, `+90553%`],
    );
    await c.query("DELETE FROM app_user WHERE email = $1", [ADMIN_EMAIL]);
    await c.query("DELETE FROM phone_login_code WHERE phone LIKE $1", ["+90553%"]);
  });
  await ownerPool?.end();
});

describe("Apple route'ları", () => {
  it("yapılandırma eksikse Apple'a gidilmez; log yalnızca değişken adı", async () => {
    const { GET } = await import("./apple/route.ts");
    expect(await redirectOf(() => GET(new Request("http://localhost:3000/giris/apple")))).toBe(
      "/giris?error=apple",
    );
    expect(errors).toEqual(["[giris] apple sign-in not started: config_missing:APPLE_CLIENT_ID"]);
  });

  it("geçerli callback: authorize ve token aynı redirect_uri; normal kullanıcı başarı ekranına", async () => {
    appleEnv();
    const { authorize, response } = await appleRoundTrip({ sub: `web-apple-user-${suffix}` });
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/giris/apple/callback",
    );
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/erken-erisim");
    expect(state.cookies.has("session")).toBe(true);
    expect(errors).toEqual([]);
  });

  it("yönetici Apple ile güvenli next'e (admin niyeti korunur)", async () => {
    appleEnv();
    const { response } = await appleRoundTrip(
      { sub: `web-apple-admin-${suffix}`, email: ADMIN_EMAIL, email_verified: true },
      "/yonetim/sozluk",
    );
    expect(location(response)).toBe("/yonetim/sozluk");
  });

  it.each([
    ["state uyuşmuyor", { state: "baska" }, "state_mismatch"],
    [
      "kullanıcı vazgeçti",
      { error: "user_cancelled_authorize" },
      "provider:user_cancelled_authorize",
    ],
  ])("%s → genel mesaj + %s logu", async (_label, override, category) => {
    appleEnv();
    state.cookies.set("apple_oauth_state", "s");
    state.cookies.set("apple_oauth_nonce", "n");
    const form = new FormData();
    form.set("code", "c");
    form.set("state", "s");
    for (const [k, v] of Object.entries(override)) form.set(k, v);
    const { POST } = await import("./apple/callback/route.ts");
    const response = await POST(
      new Request("http://localhost:3000/giris/apple/callback", { method: "POST", body: form }),
    );
    expect(location(response)).toBe("/giris?error=apple");
    expect(errors).toEqual([`[giris] apple sign-in rejected: ${category}`]);
  });

  it("geçersiz token (yanlış audience) → oturum yok, kategori logu", async () => {
    appleEnv();
    const { response } = await appleRoundTrip({ sub: `web-apple-bad-${suffix}`, aud: "com.baska" });
    expect(location(response)).toBe("/giris?error=apple");
    expect(errors).toEqual(["[giris] apple sign-in failed: id_token:audience"]);
    expect(state.cookies.has("session")).toBe(false);
  });
});

describe("telefon route'ları", () => {
  const p = (n: number) => `0553${String(suffix + n).slice(-7)}`;

  it("desteklenmeyen ülke ayrı mesaj alır, SMS gitmez", async () => {
    netgsmEnv();
    const bodies = stubNetgsm("00");
    const response = await postPhone("kod-gonder", { phone: "+44 20 7946 0958" });
    expect(location(response)).toBe("/giris/telefon?hata=ulke");
    expect(bodies).toHaveLength(0);
  });

  it("sağlayıcı yapılandırılmamış → gönderilemedi, kod oluşmaz, log kategori", async () => {
    vi.stubEnv("SMS_PROVIDER", "netgsm");
    const response = await postPhone("kod-gonder", { phone: p(1) });
    expect(location(response)).toBe("/giris/telefon?hata=gonderilemedi");
    expect(errors).toEqual(["[giris] phone code not sent: sms_unavailable"]);
    const rows = await owner((c) =>
      c.query("SELECT 1 FROM phone_login_code WHERE phone = $1", [`+90${p(1).slice(1)}`]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("Netgsm hatası → gönderilemedi; log sağlayıcı kodunu taşır, numarayı taşımaz", async () => {
    netgsmEnv();
    stubNetgsm("30");
    const response = await postPhone("kod-gonder", { phone: p(2) });
    expect(location(response)).toBe("/giris/telefon?hata=gonderilemedi");
    expect(errors).toEqual(["[giris] phone code not sent: sms:netgsm:30"]);
    expect(errors.join()).not.toContain(p(2).slice(1));
  });

  it("başarılı akış: kod → tekrar gönderme beklemesi → yanlış kod → doğru kod → başarı ekranı", async () => {
    netgsmEnv();
    const bodies = stubNetgsm("00");
    const first = await postPhone("kod-gonder", { phone: p(3), next: "/yonetim" });
    expect(location(first)).toBe("/giris/telefon?adim=kod");
    const sms = JSON.parse(bodies[0] ?? "{}") as { no: string; msg: string };
    expect(sms.no).toBe(p(3).slice(1));
    const code = /(\d{6})/.exec(sms.msg)?.[1] ?? "";

    // 60 sn içinde ikinci istek: tekrar gönderme beklemesi (Redis).
    expect(location(await postPhone("kod-gonder", { phone: p(3) }))).toBe(
      "/giris/telefon?hata=sinir",
    );

    const wrong = code === "000000" ? "111111" : "000000";
    expect(location(await postPhone("dogrula", { code: wrong }))).toBe(
      "/giris/telefon?adim=kod&hata=kod",
    );
    const ok = await postPhone("dogrula", { code });
    // Normal kullanıcı: yönetim niyeti taşısa da başarı ekranına.
    expect(location(ok)).toBe("/erken-erisim");
    expect(state.cookies.has("session")).toBe(true);
    // Tekrar kullanım: aynı kod ikinci kez geçmez.
    state.cookies.set("phone_login", `+90${p(3).slice(1)}`);
    expect(location(await postPhone("dogrula", { code }))).toBe("/giris/telefon?adim=kod&hata=kod");
    expect(errors).toEqual([]);
  });
});

describe("giriş ekranlarında sağlayıcı durumu", () => {
  async function html(path: "page" | "yonetim/page" | "telefon/page"): Promise<string> {
    const { default: Page } = await import(`./${path}.tsx`);
    return renderToStaticMarkup(
      (await Page({ searchParams: Promise.resolve({}) })) as ReactElement,
    );
  }

  it("yapılandırılmamış Apple ve telefon bağlantı olmaz, 'şu an kullanılamıyor' görünür", async () => {
    // Netgsm seçili ama NETGSM_* eksik: her ortamda kullanılamaz (fail-closed).
    vi.stubEnv("SMS_PROVIDER", "netgsm");
    for (const path of ["page", "yonetim/page"] as const) {
      const markup = await html(path);
      expect(markup).not.toContain('href="/giris/apple');
      expect(markup).not.toContain('href="/giris/telefon');
      expect(markup).toContain("Apple ile devam edin (şu an kullanılamıyor)");
      expect(markup).toContain("Telefon ile devam edin (şu an kullanılamıyor)");
    }
    const phonePage = await html("telefon/page");
    expect(phonePage).toContain("Telefonla giriş şu an kullanılamıyor");
    expect(phonePage).not.toContain('action="/giris/telefon/kod-gonder"');
  });

  it("yapılandırılmışsa bağlantılar çalışır", async () => {
    appleEnv();
    netgsmEnv();
    const markup = await html("page");
    expect(markup).toContain('href="/giris/apple"');
    expect(markup).toContain('href="/giris/telefon"');
    expect(await html("telefon/page")).toContain('action="/giris/telefon/kod-gonder"');
  });
});
