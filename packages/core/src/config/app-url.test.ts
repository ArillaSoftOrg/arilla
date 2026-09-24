import { describe, expect, it } from "vitest";
import { normalizeAppUrl, readAppUrl, requireAppUrl } from "./app-url.ts";

describe("normalizeAppUrl", () => {
  it("tanimsiz veya bos degerde undefined doner", () => {
    expect(normalizeAppUrl(undefined)).toBeUndefined();
    expect(normalizeAppUrl("")).toBeUndefined();
    expect(normalizeAppUrl("   ")).toBeUndefined();
  });

  it("bosluklari ve sondaki slash'i kaldirir", () => {
    expect(normalizeAppUrl("  https://alan-adi.com/  ")).toBe("https://alan-adi.com");
    expect(normalizeAppUrl("https://alan-adi.com")).toBe("https://alan-adi.com");
  });

  it("tirnak icindeki degeri kabul eder", () => {
    expect(normalizeAppUrl('"https://alan-adi.com/"')).toBe("https://alan-adi.com");
  });

  it("portu korur", () => {
    expect(normalizeAppUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("protokolsuz degeri reddeder", () => {
    expect(() => normalizeAppUrl("alan-adi.com")).toThrow(/APP_URL/);
  });

  it("http/https disindaki protokolu reddeder", () => {
    expect(() => normalizeAppUrl("ftp://alan-adi.com")).toThrow(/http/);
  });

  it("yol, sorgu veya hash iceren degeri reddeder", () => {
    expect(() => normalizeAppUrl("https://alan-adi.com/tr")).toThrow(/kok adres/);
    expect(() => normalizeAppUrl("https://alan-adi.com/?x=1")).toThrow(/kok adres/);
    expect(() => normalizeAppUrl("https://alan-adi.com/#a")).toThrow(/kok adres/);
  });
});

describe("readAppUrl", () => {
  it("hicbir sey tanimli degilse (yerel) undefined doner", () => {
    expect(readAppUrl({})).toBeUndefined();
    expect(readAppUrl({ APP_URL: "  " })).toBeUndefined();
  });

  it("APP_URL'i normalize eder", () => {
    expect(readAppUrl({ APP_URL: "https://alan-adi.com/" })).toBe("https://alan-adi.com");
  });

  it("APP_URL, Vercel host'undan once gelir", () => {
    expect(
      readAppUrl({
        APP_URL: "https://ozel-alan.com",
        VERCEL_PROJECT_PRODUCTION_URL: "proje.vercel.app",
      }),
    ).toBe("https://ozel-alan.com");
  });

  it("APP_URL yoksa Vercel production host'una https ile duser", () => {
    expect(readAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: "proje.vercel.app" })).toBe(
      "https://proje.vercel.app",
    );
    expect(
      readAppUrl({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: " proje.vercel.app/ ",
      }),
    ).toBe("https://proje.vercel.app");
  });

  it("Vercel host'u yol iceriyorsa reddeder", () => {
    expect(() => readAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: "proje.vercel.app/tr" })).toThrow(
      /VERCEL_PROJECT_PRODUCTION_URL/,
    );
  });

  it("yerel production build'de (VERCEL_ENV yok) http://localhost'a izin verir", () => {
    expect(readAppUrl({ APP_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  it("Vercel preview'da localhost'u engellemez (canonical yalnizca production'da zorunlu)", () => {
    expect(readAppUrl({ VERCEL_ENV: "preview", APP_URL: "http://localhost:3000" })).toBe(
      "http://localhost:3000",
    );
  });

  it("Vercel production'da hicbir sey cozulmezse firlatir", () => {
    expect(() => readAppUrl({ VERCEL_ENV: "production" })).toThrow(/Vercel production/);
    expect(() => readAppUrl({ VERCEL_ENV: "production", APP_URL: " " })).toThrow(/tanimli degil/);
  });

  it("Vercel production'da http reddedilir", () => {
    expect(() => readAppUrl({ VERCEL_ENV: "production", APP_URL: "http://alan-adi.com" })).toThrow(
      /https/,
    );
  });

  it("Vercel production'da localhost reddedilir", () => {
    for (const url of ["https://localhost", "https://127.0.0.1:3000", "https://app.localhost"]) {
      expect(() => readAppUrl({ VERCEL_ENV: "production", APP_URL: url })).toThrow(/localhost/);
    }
    // Acik APP_URL yanlissa Vercel host'u onu sessizce kurtarmaz.
    expect(() =>
      readAppUrl({
        VERCEL_ENV: "production",
        APP_URL: "http://localhost:3000",
        VERCEL_PROJECT_PRODUCTION_URL: "proje.vercel.app",
      }),
    ).toThrow();
  });

  it("Vercel production'da gecerli https adresini doner", () => {
    expect(readAppUrl({ VERCEL_ENV: "production", APP_URL: "https://alan-adi.com/" })).toBe(
      "https://alan-adi.com",
    );
  });
});

describe("requireAppUrl", () => {
  it("tanimsizsa firlatir", () => {
    expect(() => requireAppUrl({})).toThrow(/tanimli degil/);
  });

  it("tanimliysa normalize edilmis degeri doner", () => {
    expect(requireAppUrl({ APP_URL: "https://alan-adi.com/" })).toBe("https://alan-adi.com");
  });

  it("Vercel host'una duser", () => {
    expect(requireAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: "proje.vercel.app" })).toBe(
      "https://proje.vercel.app",
    );
  });

  it("Vercel preview'da e-posta linki deploy'un kendi adresine gider", () => {
    const env = {
      VERCEL_ENV: "preview",
      VERCEL_URL: "proje-git-dal.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "proje.vercel.app",
    };
    expect(requireAppUrl(env)).toBe("https://proje-git-dal.vercel.app");
    // canonical/sitemap production host'unda kalir
    expect(readAppUrl(env)).toBe("https://proje.vercel.app");
  });

  it("preview'da APP_URL ayarliysa o kullanilir", () => {
    expect(
      requireAppUrl({
        VERCEL_ENV: "preview",
        VERCEL_URL: "proje-git-dal.vercel.app",
        APP_URL: "https://onizleme.alan-adi.com",
      }),
    ).toBe("https://onizleme.alan-adi.com");
  });
});

describe("normalizeAppUrl kimlik bilgisi", () => {
  it("parola iceren degeri reddeder ve mesajda degeri gostermez", () => {
    let message = "";
    try {
      normalizeAppUrl("https://:gizli-parola@alan-adi.com");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/kullanici adi\/parola/);
    expect(message).not.toContain("gizli-parola");
  });
});
