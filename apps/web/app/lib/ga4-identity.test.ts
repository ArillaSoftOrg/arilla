/**
 * Karar 0088: Vercel OIDC bağdaştırıcısı GERÇEK `@vercel/oidc` kütüphanesiyle
 * sınanır (sahte yok). Vercel'in istek bağlamı, çalışma zamanının kullandığı
 * `Symbol.for("@vercel/request-context")` ile kurulur; belirteçler sahte,
 * imzasız JWT'lerdir (yalnızca `exp` okunur, Google'a gitmez).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ga4ServerTransport, vercelOidcToken } from "./ga4-identity.ts";

const CONTEXT = Symbol.for("@vercel/request-context");
type Global = Record<symbol, unknown>;

function jwt(expSecondsFromNow: number, sub = "owner:ekip:project:proje:environment:production") {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  return `${part({ alg: "RS256", typ: "JWT" })}.${part({ sub, exp })}.sahte-imza`;
}

function setRequestContext(headers: Record<string, string> | null) {
  if (headers === null) delete (globalThis as Global)[CONTEXT];
  else (globalThis as Global)[CONTEXT] = { get: () => ({ headers }) };
}

const ON_VERCEL = { VERCEL: "1" } as const;
let savedEnvToken: string | undefined;

beforeEach(() => {
  savedEnvToken = process.env.VERCEL_OIDC_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  setRequestContext(null);
});

afterEach(() => {
  setRequestContext(null);
  if (savedEnvToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
  else process.env.VERCEL_OIDC_TOKEN = savedEnvToken;
});

describe("Vercel OIDC belirteci - resmi getVercelOidcToken()", () => {
  it("Vercel istek bağlamındaki belirteç alınır (Next başlıklarından bağımsız)", async () => {
    const token = jwt(7200);
    setRequestContext({ "x-vercel-oidc-token": token });
    expect(await vercelOidcToken(ON_VERCEL)).toBe(token);
  });

  it("istek bağlamı ortam değişkeninden önce gelir", async () => {
    const fromContext = jwt(7200);
    process.env.VERCEL_OIDC_TOKEN = jwt(7200, "owner:ekip:project:proje:environment:preview");
    setRequestContext({ "x-vercel-oidc-token": fromContext });
    expect(await vercelOidcToken(ON_VERCEL)).toBe(fromContext);
  });

  it("bağlamda yoksa VERCEL_OIDC_TOKEN kullanılır", async () => {
    const token = jwt(3600);
    process.env.VERCEL_OIDC_TOKEN = token;
    setRequestContext({});
    expect(await vercelOidcToken(ON_VERCEL)).toBe(token);
  });

  it("belirteç yok, bozuk ya da süresi geçmiş: null; belirteç ortama ya da diske yazılmaz", async () => {
    expect(await vercelOidcToken(ON_VERCEL)).toBeNull();
    setRequestContext({ "x-vercel-oidc-token": "jwt-degil" });
    expect(await vercelOidcToken(ON_VERCEL)).toBeNull();
    setRequestContext({ "x-vercel-oidc-token": jwt(-60) });
    expect(await vercelOidcToken(ON_VERCEL)).toBeNull();
    // Yenileme yolu bağlı proje (.vercel) bulamadığı için hiçbir şey yazmadan düşer.
    expect(process.env.VERCEL_OIDC_TOKEN).toBeUndefined();
  });

  it("Vercel dışında kütüphane hiç çağrılmaz; bağlam ve ortam değişkeni yok sayılır", async () => {
    setRequestContext({ "x-vercel-oidc-token": jwt(7200) });
    process.env.VERCEL_OIDC_TOKEN = jwt(7200);
    let calls = 0;
    const read = async () => {
      calls += 1;
      return "kullanilmamali";
    };
    expect(await vercelOidcToken({}, read)).toBeNull();
    expect(await vercelOidcToken({ VERCEL: "0" }, read)).toBeNull();
    expect(calls).toBe(0);
  });

  it("kütüphane hatası mesajı dışarı taşınmaz; boş belirteç null", async () => {
    const failing = async () => {
      throw new Error("project.json not found /Users/gizli/yol");
    };
    expect(await vercelOidcToken(ON_VERCEL, failing)).toBeNull();
    expect(await vercelOidcToken(ON_VERCEL, async () => "   ")).toBeNull();
  });

  it("taşıyıcı belirteci her çağrıda yeniden okur (önbellek yok)", async () => {
    const original = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      const transport = ga4ServerTransport();
      const first = jwt(7200);
      setRequestContext({ "x-vercel-oidc-token": first });
      expect(await transport.subjectToken?.()).toBe(first);
      const second = jwt(5400);
      setRequestContext({ "x-vercel-oidc-token": second });
      expect(await transport.subjectToken?.()).toBe(second);
    } finally {
      if (original === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = original;
    }
  });
});
