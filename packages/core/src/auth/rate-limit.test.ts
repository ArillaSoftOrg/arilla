import { describe, expect, it } from "vitest";
import { RedisUnavailableError } from "../redis/client.ts";
import {
  authRateLimitKeys,
  checkAuthRateLimit,
  EMAIL_DAILY_MAX_REQUESTS,
  EMAIL_HOURLY_MAX_REQUESTS,
  RateLimitExceededError,
} from "./rate-limit.ts";

/**
 * Bellekte sabit pencere: anahtar basina sayac, `advance` ile zaman ilerler.
 * Pencere dolunca sayac sifirlanir (Redis TTL davranisi).
 */
function fakeCounter() {
  let now = 0;
  const windows = new Map<string, { count: number; expiresAt: number }>();
  return {
    advance(seconds: number) {
      now += seconds;
    },
    increment: async (key: string, windowSeconds: number) => {
      const current = windows.get(key);
      if (!current || current.expiresAt <= now) {
        windows.set(key, { count: 1, expiresAt: now + windowSeconds });
        return 1;
      }
      current.count += 1;
      return current.count;
    },
  };
}

describe("checkAuthRateLimit()", () => {
  const email = "sinir@example.test";

  it("ayni adrese dakikada bir istek", async () => {
    const counter = fakeCounter();
    await checkAuthRateLimit({ email, ip: null }, counter.increment);
    await expect(checkAuthRateLimit({ email, ip: null }, counter.increment)).rejects.toThrow(
      RateLimitExceededError,
    );
  });

  it("adres basina saatlik tavan: dakikalar gecse de saatte en fazla 5", async () => {
    const counter = fakeCounter();
    for (let i = 0; i < EMAIL_HOURLY_MAX_REQUESTS; i++) {
      // Her istek farkli IP'den: IP siniri devreye girmesin.
      await checkAuthRateLimit({ email, ip: `203.0.113.${i}` }, counter.increment);
      counter.advance(61);
    }
    await expect(
      checkAuthRateLimit({ email, ip: "198.51.100.1" }, counter.increment),
    ).rejects.toThrow(RateLimitExceededError);
    counter.advance(60 * 60);
    await expect(
      checkAuthRateLimit({ email, ip: "198.51.100.2" }, counter.increment),
    ).resolves.toBeUndefined();
  });

  it("adres basina gunluk tavan: saatler gecse de gunde en fazla 10", async () => {
    const counter = fakeCounter();
    let allowed = 0;
    for (let hour = 0; hour < 23; hour++) {
      try {
        await checkAuthRateLimit({ email, ip: `203.0.113.${hour}` }, counter.increment);
        allowed += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitExceededError);
      }
      counter.advance(60 * 60);
    }
    expect(allowed).toBe(EMAIL_DAILY_MAX_REQUESTS);
  });

  it("farkli adresler birbirinin hakkini tuketmez; IP siniri korunur", async () => {
    const counter = fakeCounter();
    for (let i = 0; i < 10; i++) {
      await checkAuthRateLimit(
        { email: `kisi${i}@example.test`, ip: "203.0.113.9" },
        counter.increment,
      );
    }
    await expect(
      checkAuthRateLimit({ email: "kisi10@example.test", ip: "203.0.113.9" }, counter.increment),
    ).rejects.toThrow(RateLimitExceededError);
  });

  it("Redis yoksa kapali kalir (hata cagirana iletilir)", async () => {
    const down = async () => {
      throw new RedisUnavailableError("sayac");
    };
    await expect(checkAuthRateLimit({ email, ip: null }, down)).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });
});

describe("authRateLimitKeys()", () => {
  it("e-postayi ve IP'yi anahtara duz yazmaz", () => {
    const { emailKey, ipKey } = authRateLimitKeys({
      email: "Ayse@Example.test",
      ip: "203.0.113.7",
    });
    expect(emailKey).toMatch(/^ratelimit:auth:email:[0-9a-f]{64}$/);
    expect(ipKey).toMatch(/^ratelimit:auth:ip:[0-9a-f]{64}$/);
    expect(emailKey.toLowerCase()).not.toContain("ayse");
    expect(ipKey).not.toContain("203.0.113.7");
  });

  it("e-posta buyuk/kucuk harf ve bosluktan bagimsiz ayni anahtari uretir", () => {
    const a = authRateLimitKeys({ email: " Ayse@Example.test ", ip: null });
    const b = authRateLimitKeys({ email: "ayse@example.test", ip: null });
    expect(a.emailKey).toBe(b.emailKey);
    expect(a.ipKey).toBeNull();
  });
});
