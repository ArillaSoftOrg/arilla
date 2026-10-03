import { describe, expect, it } from "vitest";
import { normalizeClickSurface } from "../attribution/record-click.ts";
import { normalizeActivityQuery, QUERY_NORM_MAX_LENGTH } from "./record.ts";
import {
  classifyBrowser,
  classifyDevice,
  normalizeCountryCode,
  requestContextFromHeaders,
} from "./request-context.ts";
import { LAST_ACTIVE_THROTTLE_MS, shouldTouchLastActive } from "./summary.ts";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0",
  bot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

describe("kaba istek bağlamı", () => {
  it("cihaz sınıfı", () => {
    expect(classifyDevice(UA.iphoneSafari)).toBe("mobile");
    expect(classifyDevice(UA.androidChrome)).toBe("mobile");
    expect(classifyDevice(UA.androidTablet)).toBe("tablet");
    expect(classifyDevice(UA.ipad)).toBe("tablet");
    expect(classifyDevice(UA.windowsEdge)).toBe("desktop");
    expect(classifyDevice(UA.macFirefox)).toBe("desktop");
    expect(classifyDevice(UA.bot)).toBe("other");
    expect(classifyDevice("")).toBeNull();
    expect(classifyDevice(null)).toBeNull();
    expect(classifyDevice("tamamen-bilinmeyen")).toBe("other");
  });

  it("tarayıcı ailesi (Edge/Opera/Samsung Chrome'dan önce)", () => {
    expect(classifyBrowser(UA.iphoneSafari)).toBe("safari");
    expect(classifyBrowser(UA.androidChrome)).toBe("chrome");
    expect(classifyBrowser(UA.windowsEdge)).toBe("edge");
    expect(classifyBrowser(UA.macFirefox)).toBe("firefox");
    expect(classifyBrowser(UA.samsung)).toBe("samsung");
    expect(classifyBrowser(UA.opera)).toBe("opera");
    expect(classifyBrowser(UA.bot)).toBe("other");
    expect(classifyBrowser(undefined)).toBeNull();
  });

  it("ülke kodu yalnızca iki büyük harf; XX ve bozuk değer NULL", () => {
    expect(normalizeCountryCode("TR")).toBe("TR");
    expect(normalizeCountryCode(" de ")).toBe("DE");
    expect(normalizeCountryCode("XX")).toBeNull();
    expect(normalizeCountryCode("TUR")).toBeNull();
    expect(normalizeCountryCode("İstanbul")).toBeNull();
    expect(normalizeCountryCode("1")).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
  });

  it("başlıklardan bağlam: ham user agent dönmez", () => {
    const headers = new Map<string, string>([
      ["user-agent", UA.androidChrome],
      ["x-vercel-ip-country", "TR"],
      ["x-real-ip", "203.0.113.9"],
    ]);
    const context = requestContextFromHeaders({ get: (name) => headers.get(name) ?? null });
    expect(context).toEqual({ deviceClass: "mobile", browserFamily: "chrome", countryCode: "TR" });
    expect(JSON.stringify(context)).not.toContain("203.0.113.9");
    expect(JSON.stringify(context)).not.toContain("Pixel");
  });
});

describe("son aktif eşiği", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  it("önceki kullanım yoksa ya da eşik geçtiyse yazar", () => {
    expect(shouldTouchLastActive(null, now)).toBe(true);
    expect(shouldTouchLastActive(new Date(now.getTime() - LAST_ACTIVE_THROTTLE_MS), now)).toBe(
      true,
    );
  });
  it("eşik içinde yazmaz", () => {
    expect(shouldTouchLastActive(new Date(now.getTime() - 60_000), now)).toBe(false);
  });
});

describe("analitik sorgu normalizasyonu", () => {
  it("Türkçe küçük harf, boşluk sadeleştirme, uzunluk sınırı", () => {
    expect(normalizeActivityQuery("  Siyah   ISLAK Mendil ")).toBe("siyah ıslak mendil");
    expect(normalizeActivityQuery("a".repeat(500))?.length).toBe(QUERY_NORM_MAX_LENGTH);
    expect(normalizeActivityQuery("   ")).toBeNull();
  });
});

describe("tıklama yüzeyi allowlist'i", () => {
  it("yalnızca bilinen yüzeyler yazılır", () => {
    expect(normalizeClickSurface("compare")).toBe("compare");
    expect(normalizeClickSurface("product_primary")).toBe("product_primary");
    expect(normalizeClickSurface("<script>")).toBeNull();
    expect(normalizeClickSurface("ad@example.com")).toBeNull();
    expect(normalizeClickSurface(null)).toBeNull();
  });
});
