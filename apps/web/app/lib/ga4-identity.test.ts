import { beforeEach, describe, expect, it, vi } from "vitest";

const requestHeaders = vi.hoisted(() => ({ value: new Headers() as Headers | null }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (!requestHeaders.value) throw new Error("istek bağlamı yok");
    return requestHeaders.value;
  },
}));

const { ga4ServerTransport, vercelOidcToken } = await import("./ga4-identity.ts");

const TOKEN = "eyJ.istek-basligindaki-oidc.imza";

beforeEach(() => {
  requestHeaders.value = new Headers();
});

describe("Vercel OIDC belirteci (karar 0088)", () => {
  it("Vercel üzerinde istek başlığındaki belirteç kullanılır", async () => {
    requestHeaders.value = new Headers({ "x-vercel-oidc-token": TOKEN });
    expect(await vercelOidcToken({ VERCEL: "1", VERCEL_OIDC_TOKEN: "eski-ortam" })).toBe(TOKEN);
  });

  it("Vercel dışında istemcinin gönderdiği başlık kimlik sayılmaz", async () => {
    requestHeaders.value = new Headers({ "x-vercel-oidc-token": TOKEN });
    expect(await vercelOidcToken({})).toBeNull();
    expect(await vercelOidcToken({ VERCEL_OIDC_TOKEN: "yerel-ortam" })).toBe("yerel-ortam");
  });

  it("başlık yoksa ya da istek bağlamı yoksa ortam değişkenine düşer", async () => {
    expect(await vercelOidcToken({ VERCEL: "1", VERCEL_OIDC_TOKEN: " ortam " })).toBe("ortam");
    requestHeaders.value = null;
    expect(await vercelOidcToken({ VERCEL: "1", VERCEL_OIDC_TOKEN: "ortam" })).toBe("ortam");
    expect(await vercelOidcToken({ VERCEL: "1" })).toBeNull();
  });

  it("taşıyıcı belirteci yalnızca istendiğinde, istek anında okur", async () => {
    const transport = ga4ServerTransport();
    expect(typeof transport.subjectToken).toBe("function");
    expect(typeof transport.fetch).toBe("function");
  });
});
