import { describe, expect, it } from "vitest";
import { approximateTry, type FxQuote, MAX_RATE_AGE_DAYS } from "./fx.ts";

const QUOTE: FxQuote = {
  source: "tcmb",
  base: "USD",
  rate: "49.39290000",
  rateKind: "forex_selling",
  effectiveDate: "2026-10-14",
  bulletin: "2026/194",
};
const NOW = new Date("2026-10-14T12:00:00Z");

describe("approximateTry (karar 0113)", () => {
  it("USD cent -> yaklasik TRY kurus, tamsayi ve yarim yukari", () => {
    // 22.11 USD * 49.3929 = 1092.077... TL
    expect(approximateTry(2211, "USD", QUOTE, NOW)).toEqual({
      approxTryMinor: 109208,
      originalMinor: 2211,
      currency: "USD",
      quote: QUOTE,
    });
    expect(approximateTry(1, "USD", { ...QUOTE, rate: "0.5" }, NOW)?.approxTryMinor).toBe(1);
  });

  it("kur yoksa, para birimi uyusmuyorsa ya da TRY ise donusum yok", () => {
    expect(approximateTry(2211, "USD", null, NOW)).toBeNull();
    expect(approximateTry(2211, "EUR", QUOTE, NOW)).toBeNull();
    expect(approximateTry(2211, "TRY", { ...QUOTE, base: "TRY" }, NOW)).toBeNull();
  });

  it("eski kur kullanilmaz (uydurma yok); hafta sonu boslugu tolere edilir", () => {
    const old = new Date(Date.parse("2026-10-14T00:00:00Z") + (MAX_RATE_AGE_DAYS + 1) * 86_400_000);
    expect(approximateTry(2211, "USD", QUOTE, old)).toBeNull();
    const weekend = new Date("2026-10-17T09:00:00Z");
    expect(approximateTry(2211, "USD", QUOTE, weekend)).not.toBeNull();
    expect(approximateTry(2211, "USD", { ...QUOTE, effectiveDate: "2026-10-20" }, NOW)).toBeNull();
  });

  it("gecersiz kur ve tutar reddedilir", () => {
    for (const rate of ["0", "-1", "abc", "1e3", ""]) {
      expect(approximateTry(2211, "USD", { ...QUOTE, rate }, NOW)).toBeNull();
    }
    expect(approximateTry(0, "USD", QUOTE, NOW)).toBeNull();
    expect(approximateTry(1.5, "USD", QUOTE, NOW)).toBeNull();
  });
});
