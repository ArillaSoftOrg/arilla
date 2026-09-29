import { describe, expect, it, vi } from "vitest";
import { isValidRequestKey } from "./charge.ts";
import { DEFAULT_DAILY_SEARCH_LIMIT, dailySearchLimit } from "./config.ts";
import { istanbulDay, nextResetAt } from "./day.ts";
import { aiSearchRateLimitKey, checkAiSearchRateLimit } from "./rate-limit.ts";
import { generateReferralCode, normalizeReferralCode } from "./referral.ts";
import { cappedCredit, splitCharge } from "./split.ts";

describe("istanbulDay() / nextResetAt()", () => {
  it("gun sinirini Istanbul 00:00'da ceker (UTC 21:00)", () => {
    expect(istanbulDay(new Date("2026-09-30T20:59:59Z"))).toBe("2026-09-30");
    expect(istanbulDay(new Date("2026-09-30T21:00:00Z"))).toBe("2026-10-01");
  });

  it("yenilenme bir sonraki Istanbul gece yarisidir", () => {
    expect(nextResetAt(new Date("2026-09-30T08:00:00Z")).toISOString()).toBe(
      "2026-09-30T21:00:00.000Z",
    );
    // 23:59:59 Istanbul -> bir saniye sonra
    expect(nextResetAt(new Date("2026-09-30T20:59:59Z")).toISOString()).toBe(
      "2026-09-30T21:00:00.000Z",
    );
    // Tam 00:00 Istanbul -> ertesi gece yarisi
    expect(nextResetAt(new Date("2026-09-30T21:00:00Z")).toISOString()).toBe(
      "2026-10-01T21:00:00.000Z",
    );
  });

  it("ay ve yil sonunu dogru gecer", () => {
    expect(nextResetAt(new Date("2026-12-31T12:00:00Z")).toISOString()).toBe(
      "2026-12-31T21:00:00.000Z",
    );
    expect(istanbulDay(new Date("2026-12-31T21:30:00Z"))).toBe("2027-01-01");
  });
});

describe("splitCharge()", () => {
  it("once gunluk hakki kullanir", () => {
    expect(splitCharge({ cost: 1, dailyLimit: 10, dailyUsed: 3, bonusBalance: 5 })).toEqual({
      fromDaily: 1,
      fromBonus: 0,
    });
  });

  it("gunluk bitince bonusa gecer", () => {
    expect(splitCharge({ cost: 1, dailyLimit: 10, dailyUsed: 10, bonusBalance: 5 })).toEqual({
      fromDaily: 0,
      fromBonus: 1,
    });
  });

  it("maliyet >1 ise kalan gunlukten sonra bonustan tamamlar", () => {
    expect(splitCharge({ cost: 3, dailyLimit: 10, dailyUsed: 9, bonusBalance: 5 })).toEqual({
      fromDaily: 1,
      fromBonus: 2,
    });
  });

  it("ikisi de yetmezse hic harcamaz", () => {
    expect(splitCharge({ cost: 1, dailyLimit: 10, dailyUsed: 10, bonusBalance: 0 })).toBeNull();
    expect(splitCharge({ cost: 3, dailyLimit: 10, dailyUsed: 9, bonusBalance: 1 })).toBeNull();
  });

  it("gecersiz maliyeti reddeder", () => {
    expect(() => splitCharge({ cost: 0, dailyLimit: 10, dailyUsed: 0, bonusBalance: 0 })).toThrow();
    expect(() =>
      splitCharge({ cost: 1.5, dailyLimit: 10, dailyUsed: 0, bonusBalance: 0 }),
    ).toThrow();
  });
});

describe("cappedCredit()", () => {
  it("tavana kirpar", () => {
    expect(cappedCredit({ amount: 10, balance: 95, max: 100 })).toBe(5);
    expect(cappedCredit({ amount: 10, balance: 100, max: 100 })).toBe(0);
    expect(cappedCredit({ amount: 3, balance: 0, max: 100 })).toBe(3);
  });
});

describe("dailySearchLimit()", () => {
  it("varsayilan 10, gecersiz degerde varsayilana doner", () => {
    expect(dailySearchLimit({})).toBe(DEFAULT_DAILY_SEARCH_LIMIT);
    expect(dailySearchLimit({ AI_SEARCH_DAILY_LIMIT: "5" })).toBe(5);
    expect(dailySearchLimit({ AI_SEARCH_DAILY_LIMIT: "-1" })).toBe(10);
    expect(dailySearchLimit({ AI_SEARCH_DAILY_LIMIT: "abc" })).toBe(10);
  });
});

describe("davet kodu", () => {
  it("uretilen kod bicime uyar ve karistirilabilen karakter icermez", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateReferralCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(normalizeReferralCode(code)).toBe(code);
    }
  });

  it("kucuk harfi ve bosluklari kanoniklestirir, gecersizi reddeder", () => {
    expect(normalizeReferralCode(" abcd2345 ")).toBe("ABCD2345");
    expect(normalizeReferralCode("ABCD1234")).toBeNull(); // 1 yok
    expect(normalizeReferralCode("ABCDO234")).toBeNull(); // O yok
    expect(normalizeReferralCode("ABC")).toBeNull();
    expect(normalizeReferralCode(42)).toBeNull();
  });
});

describe("isValidRequestKey()", () => {
  it("opak, sinirli uzunlukta anahtarlari kabul eder", () => {
    expect(isValidRequestKey("0f9e4a3c-5b1d-4c2e-9a7b-1234567890ab")).toBe(true);
    expect(isValidRequestKey("short")).toBe(false);
    expect(isValidRequestKey("a".repeat(101))).toBe(false);
    expect(isValidRequestKey("has space 1234")).toBe(false);
    expect(isValidRequestKey(undefined)).toBe(false);
  });
});

describe("checkAiSearchRateLimit()", () => {
  /** `incrementFixedWindow`'un kullandigi MULTI zincirini anahtar basina sayan sahte Redis. */
  function fakeRedis() {
    const counts = new Map<string, number>();
    const client = {
      multi: () => {
        let key = "";
        const chain = {
          set: (k: string) => {
            key = k;
            return chain;
          },
          incr: () => chain,
          ttl: () => chain,
          exec: async () => {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return [
              [null, "OK"],
              [null, next],
              [null, 60],
            ];
          },
        };
        return chain;
      },
      expire: vi.fn(async () => 1),
    };
    // biome-ignore lint/suspicious/noExplicitAny: yalnizca kullanilan ioredis yuzeyi taklit edilir
    return { client: client as any, counts };
  }

  it("dakikada 4. istegi reddeder", async () => {
    const { client } = fakeRedis();
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await checkAiSearchRateLimit(7, client)).allowed);
    expect(results).toEqual([true, true, true, false]);
  });

  it("saatte 11. istegi reddeder (dakika pencereleri dolmasa bile)", async () => {
    const { client, counts } = fakeRedis();
    const results: boolean[] = [];
    for (let i = 0; i < 11; i++) {
      // Her istek yeni bir dakika penceresinde: yalnizca saat siniri isler.
      counts.delete(aiSearchRateLimitKey("min", 8));
      results.push((await checkAiSearchRateLimit(8, client)).allowed);
    }
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
  });
});
