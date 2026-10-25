import { beforeAll, describe, expect, it } from "vitest";
import {
  checkEmailSendRateLimit,
  checkLoginRateLimit,
  checkPasswordChangeRateLimit,
  loginRateLimitKeys,
  sendRateLimitKeys,
} from "./password-rate-limit.ts";
import { RateLimitExceededError } from "./rate-limit.ts";

/** Redis'siz sabit pencereli sayaç: anahtar başına artar, pencere süresi yok sayılır. */
function fakeCounter() {
  const counts = new Map<string, number>();
  const increment = async (key: string): Promise<number> => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
  return { counts, increment };
}

beforeAll(() => {
  process.env.SESSION_SECRET = "birim-testi-icin-sir-gercek-degil";
});

describe("giriş oran sınırı", () => {
  it("aynı e-posta+IP için 5 denemeye izin verir, 6.'da şifre denenmeden durdurur", async () => {
    const { increment } = fakeCounter();
    const input = { email: "kisi@example.test", ip: "203.0.113.5" };
    for (let i = 0; i < 5; i++) await checkLoginRateLimit(input, increment);
    await expect(checkLoginRateLimit(input, increment)).rejects.toThrow(RateLimitExceededError);
  });

  it("aynı e-postaya farklı IP'lerden gelen denemeler çift sınırını paylaşmaz ama e-posta tavanına takılır", async () => {
    const { increment } = fakeCounter();
    for (let i = 0; i < 20; i++) {
      await checkLoginRateLimit(
        { email: "kisi@example.test", ip: `203.0.113.${i + 1}` },
        increment,
      );
    }
    await expect(
      checkLoginRateLimit({ email: "kisi@example.test", ip: "198.51.100.9" }, increment),
    ).rejects.toThrow(RateLimitExceededError);
  });

  it("IP başına tavan farklı e-postaları da kapsar", async () => {
    const { increment } = fakeCounter();
    for (let i = 0; i < 30; i++) {
      await checkLoginRateLimit({ email: `k${i}@example.test`, ip: "203.0.113.5" }, increment);
    }
    await expect(
      checkLoginRateLimit({ email: "yeni@example.test", ip: "203.0.113.5" }, increment),
    ).rejects.toMatchObject({ name: "RateLimitExceededError" });
  });

  it("anahtarlarda e-posta ve IP düz metin değil takma ad olarak bulunur; büyük/küçük harf aynı", () => {
    const a = loginRateLimitKeys({ email: "Kisi@Example.Test", ip: "203.0.113.5" });
    const b = loginRateLimitKeys({ email: "kisi@example.test", ip: "203.0.113.5" });
    expect(a).toEqual(b);
    const joined = JSON.stringify(a);
    expect(joined).not.toContain("example.test");
    expect(joined).not.toContain("203.0.113.5");
  });
});

describe("e-posta gönderim oran sınırı", () => {
  it("dakikada bir istek: ikincisi reddedilir", async () => {
    const { increment } = fakeCounter();
    const input = { email: "kisi@example.test", ip: "203.0.113.5" };
    await checkEmailSendRateLimit("reset", input, increment);
    await expect(checkEmailSendRateLimit("reset", input, increment)).rejects.toThrow(
      RateLimitExceededError,
    );
  });

  it("kapsamlar (kayıt/sıfırlama/yeniden gönderim) birbirinin hakkını harcamaz", async () => {
    const { increment } = fakeCounter();
    const input = { email: "kisi@example.test", ip: "203.0.113.5" };
    await checkEmailSendRateLimit("register", input, increment);
    await checkEmailSendRateLimit("reset", input, increment);
    await checkEmailSendRateLimit("resend", input, increment);
    expect(sendRateLimitKeys("register", input).minute).not.toBe(
      sendRateLimitKeys("reset", input).minute,
    );
  });

  it("IP başına saatlik tavan (10) farklı adresleri kapsar", async () => {
    const { increment } = fakeCounter();
    for (let i = 0; i < 10; i++) {
      await checkEmailSendRateLimit(
        "register",
        { email: `k${i}@example.test`, ip: "203.0.113.5" },
        increment,
      );
    }
    await expect(
      checkEmailSendRateLimit(
        "register",
        { email: "yeni@example.test", ip: "203.0.113.5" },
        increment,
      ),
    ).rejects.toThrow(RateLimitExceededError);
  });
});

describe("şifre değiştirme oran sınırı", () => {
  it("kullanıcı başına 5 denemeden sonra durdurur", async () => {
    const { increment } = fakeCounter();
    for (let i = 0; i < 5; i++) await checkPasswordChangeRateLimit(7, increment);
    await expect(checkPasswordChangeRateLimit(7, increment)).rejects.toThrow(
      RateLimitExceededError,
    );
    await expect(checkPasswordChangeRateLimit(8, increment)).resolves.toBeUndefined();
  });
});
