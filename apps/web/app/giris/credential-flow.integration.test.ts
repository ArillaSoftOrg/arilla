/**
 * E-posta + şifre web sınırı (karar 0150): kayıt -> e-posta -> onay formu
 * (POST) -> oturum çerezi; giriş, hata, sıfırlama ve `next` süzgeci. Gerçek yerel
 * Postgres + Redis + Mailpit (`MAILPIT_API`, varsayılan http://localhost:8025);
 * `next/headers` ve `next/navigation` taklit edilir. Şifre ve token hiçbir
 * durum nesnesinde geri dönmez.
 */
import { createDatabase } from "@arilla/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

interface StoredCookie {
  value: string;
  options?: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  cookies: new Map<string, StoredCookie>(),
  headers: new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.90" }),
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

const actions = await import("./credential-actions.ts");
const verifyPage = await import("./eposta-dogrula/page.tsx");

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;

/** Fixture ve denetim için sahip rol; yerel olmayan adres görülürse test durur. */
async function withOwnerClient<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error("DATABASE_URL_OWNER tanımlı değil");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(
      `DATABASE_URL_OWNER yerel değil (${host}); test yalnızca yerel veritabanında çalışır.`,
    );
  }
  ownerPool ??= createDatabase(url).$client;
  return fn(ownerPool);
}

const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025";
const PASSWORD = "Mavi-Kedi-Pazar-42";
const suffix = Date.now();
let counter = 0;
const created: string[] = [];

function freshEmail(label: string): string {
  const email = `web-pw-${label}-${suffix}-${counter++}@example.test`;
  created.push(email);
  return email;
}

function useIp(): void {
  counter += 1;
  state.headers.set("x-forwarded-for", `198.51.100.${(suffix + counter) % 250}`);
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error("yönlendirme beklendi");
}

async function mailToken(email: string, path: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const id = ((await search.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID;
    if (id) {
      const { Text } = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
        Text: string;
      };
      const match = new RegExp(`https?://\\S+${path}\\S*`).exec(Text);
      if (match) return new URL(match[0]).searchParams.get("token") ?? "";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`e-posta gelmedi: ${email}`);
}

describe("e-posta + şifre web akışı", () => {
  beforeEach(() => {
    state.cookies.clear();
    useIp();
    vi.stubEnv("PRODUCT_ACCESS", "open");
    vi.stubEnv("EMAIL_FROM", process.env.EMAIL_FROM ?? "ManiCepte <noreply@example.test>");
    vi.stubEnv("APP_URL", process.env.APP_URL ?? "http://localhost:3000");
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM email_credential_token WHERE email = ANY($1)", [created]);
      await client.query("DELETE FROM app_user WHERE email = ANY($1)", [created]);
    });
  });

  async function registerAndVerify(email: string, next = "/") {
    const sent = await actions.registerAction(
      { status: "idle" },
      form({ email, password: PASSWORD, name: "Web Test", next }),
    );
    expect(sent).toEqual({ status: "sent", email, kind: "register" });
    const token = await mailToken(email, "/giris/eposta-dogrula");
    return { token, next };
  }

  it("kayıt çerez YAZMAZ; GET onay sayfası token'ı tüketmez; POST hesabı açar ve çerezi yazar", async () => {
    const email = freshEmail("verify");
    const { token } = await registerAndVerify(email);
    expect(state.cookies.has("session")).toBe(false);

    // GET: yalnızca form çizilir, token tüketilmez, hesap açılmaz.
    await verifyPage.default({ searchParams: Promise.resolve({ token }) });
    const pending = await withOwnerClient((client) =>
      client.query(
        "SELECT consumed_at FROM email_credential_token WHERE email = $1 AND purpose = 'verify_email'",
        [email],
      ),
    );
    expect(pending.rows[0].consumed_at).toBeNull();
    expect(state.cookies.has("session")).toBe(false);

    const to = await redirectOf(() => actions.confirmVerificationAction(form({ token })));
    expect(to).toBe("/");
    const cookie = state.cookies.get("session");
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("kullanılmış ve uydurma token giriş sayfasına hata ile döner, çerez yazılmaz", async () => {
    const email = freshEmail("replay");
    const { token } = await registerAndVerify(email);
    await redirectOf(() => actions.confirmVerificationAction(form({ token })));
    state.cookies.clear();

    expect(await redirectOf(() => actions.confirmVerificationAction(form({ token })))).toBe(
      "/giris/eposta?durum=gecersiz",
    );
    expect(
      await redirectOf(() => actions.confirmVerificationAction(form({ token: "uydurma" }))),
    ).toBe("/giris/eposta?durum=gecersiz");
    expect(state.cookies.has("session")).toBe(false);
  });

  it("doğrulama bağlantısındaki güvensiz `next` kök yola indirgenir (açık yönlendirme yok)", async () => {
    const email = freshEmail("next");
    const { token } = await registerAndVerify(email, "//evil.example/yol");
    expect(
      await redirectOf(() =>
        actions.confirmVerificationAction(form({ token, next: "//evil.example/yol" })),
      ),
    ).toBe("/");
  });

  it("giriş: doğru şifre çerez yazar ve güvenli next'e gider; hatalı şifre durum döner, çerez yok", async () => {
    const email = freshEmail("login");
    const { token } = await registerAndVerify(email);
    await redirectOf(() => actions.confirmVerificationAction(form({ token })));
    state.cookies.clear();

    const wrong = await actions.loginAction(
      { status: "idle" },
      form({ email, password: "Yanlis-Sifre-123" }),
    );
    expect(wrong).toEqual({ status: "error", code: "invalid_credentials", email });
    expect(state.cookies.has("session")).toBe(false);
    expect(JSON.stringify(wrong)).not.toContain("Yanlis-Sifre-123");

    expect(
      await redirectOf(() =>
        actions.loginAction(
          { status: "idle" },
          form({ email, password: PASSWORD, next: "/hesap" }),
        ),
      ),
    ).toBe("/hesap");
    expect(state.cookies.get("session")?.value).toBeTruthy();

    state.cookies.clear();
    expect(
      await redirectOf(() =>
        actions.loginAction(
          { status: "idle" },
          form({ email, password: PASSWORD, next: "https://evil.example" }),
        ),
      ),
    ).toBe("/");
  });

  it("var olmayan hesap ile yanlış şifre aynı yanıtı verir", async () => {
    const known = freshEmail("same-known");
    const { token } = await registerAndVerify(known);
    await redirectOf(() => actions.confirmVerificationAction(form({ token })));
    state.cookies.clear();
    const unknown = freshEmail("same-unknown");

    const a = await actions.loginAction(
      { status: "idle" },
      form({ email: known, password: "x-Yanlis-1234" }),
    );
    const b = await actions.loginAction(
      { status: "idle" },
      form({ email: unknown, password: "x-Yanlis-1234" }),
    );
    expect({ ...a, email: "" }).toEqual({ ...b, email: "" });
  });

  it("zayıf şifre kayıtta alan hatası kodu döner ve hiçbir e-posta gitmez", async () => {
    const email = freshEmail("weak");
    const result = await actions.registerAction(
      { status: "idle" },
      form({ email, password: "kisa" }),
    );
    expect(result).toMatchObject({ status: "error", code: "too_short", email });
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    expect(((await search.json()) as { messages?: unknown[] }).messages ?? []).toHaveLength(0);
  });

  it("şifre sıfırlama: tutarsız tekrar reddedilir, başarıda giriş sayfasına yönlenir ve çerez yazılmaz", async () => {
    const email = freshEmail("reset");
    const { token: verifyToken } = await registerAndVerify(email);
    await redirectOf(() => actions.confirmVerificationAction(form({ token: verifyToken })));
    state.cookies.clear();

    expect((await actions.forgotPasswordAction({ status: "idle" }, form({ email }))).status).toBe(
      "sent",
    );
    const token = await mailToken(email, "/giris/sifre-sifirla");

    expect(
      await actions.resetPasswordAction(
        { status: "idle" },
        form({ token, password: "Yeni-Sifre-Hazir-77", confirm: "Farkli-Sifre-Hazir-77" }),
      ),
    ).toEqual({ status: "error", code: "password_mismatch" });

    expect(
      await redirectOf(() =>
        actions.resetPasswordAction(
          { status: "idle" },
          form({ token, password: "Yeni-Sifre-Hazir-77", confirm: "Yeni-Sifre-Hazir-77" }),
        ),
      ),
    ).toBe("/giris/eposta?durum=sifre_degisti");
    expect(state.cookies.has("session")).toBe(false);

    // Token tek kullanımlık: ikinci deneme hata kodu döner.
    expect(
      await actions.resetPasswordAction(
        { status: "idle" },
        form({ token, password: "Baska-Sifre-Hazir-88", confirm: "Baska-Sifre-Hazir-88" }),
      ),
    ).toEqual({ status: "error", code: "token_used" });

    useIp();
    expect(
      await redirectOf(() =>
        actions.loginAction({ status: "idle" }, form({ email, password: "Yeni-Sifre-Hazir-77" })),
      ),
    ).toBe("/");
  });

  it("sıfırlama isteği var olmayan adres için de 'gönderildi' döner (hesap varlığı sızmaz)", async () => {
    const email = freshEmail("forgot-none");
    expect(await actions.forgotPasswordAction({ status: "idle" }, form({ email }))).toEqual({
      status: "sent",
      email,
      kind: "forgot",
    });
  });

  it("yapılandırma hazır değilse eylemler 'kullanılamıyor' döner ve veritabanına dokunmaz", async () => {
    vi.stubEnv("SMTP_HOST", "");
    const email = freshEmail("unavailable");
    expect(
      await actions.registerAction({ status: "idle" }, form({ email, password: PASSWORD })),
    ).toMatchObject({ status: "error", code: "unavailable" });
    const rows = await withOwnerClient((client) =>
      client.query("SELECT 1 FROM email_credential_token WHERE email = $1", [email]),
    );
    expect(rows.rows).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});
