import { describe, expect, it } from "vitest";
import {
  isRedisUnavailableError,
  RedisConfigError,
  RedisUnavailableError,
  reconnectDelayMs,
  redisOptionsFromEnv,
} from "./client.ts";

describe("redisOptionsFromEnv()", () => {
  it("REDIS_URL yoksa acik bir yapilandirma hatasi firlatir", () => {
    expect(() => redisOptionsFromEnv({})).toThrow(RedisConfigError);
    expect(() => redisOptionsFromEnv({ REDIS_URL: "  " })).toThrow(/REDIS_URL/);
  });

  it("redis:// disindaki semalari reddeder", () => {
    expect(() => redisOptionsFromEnv({ REDIS_URL: "http://example.test:6379" })).toThrow(
      RedisConfigError,
    );
  });

  it("rediss:// icin TLS'i acar", () => {
    const { options } = redisOptionsFromEnv({ REDIS_URL: "rediss://example.test:6380" });
    expect(options.tls).toEqual({});
  });

  it("production'da duz redis:// reddedilir; mesaj adresi tasimaz", () => {
    const url = "redis://default:gizli-parola@eu1.upstash.io:6379";
    expect(() => redisOptionsFromEnv({ REDIS_URL: url, VERCEL_ENV: "production" })).toThrow(
      RedisConfigError,
    );
    try {
      redisOptionsFromEnv({ REDIS_URL: url, VERCEL_ENV: "production" });
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/gizli|upstash/);
    }
  });

  it("production'da rediss:// kabul edilir ve TLS acilir", () => {
    const { url, options } = redisOptionsFromEnv({
      REDIS_URL: "rediss://default:p@eu1.upstash.io:6379",
      VERCEL_ENV: "production",
    });
    expect(url).toBe("rediss://default:p@eu1.upstash.io:6379");
    expect(options.tls).toEqual({});
  });

  it("yerel gelistirme ve onizleme redis://localhost kullanabilir", () => {
    for (const VERCEL_ENV of [undefined, "development", "preview"]) {
      const { url } = redisOptionsFromEnv({ REDIS_URL: "redis://localhost:6379", VERCEL_ENV });
      expect(url).toBe("redis://localhost:6379");
    }
  });

  it("redis:// icin TLS acmaz", () => {
    const { options } = redisOptionsFromEnv({ REDIS_URL: "redis://localhost:6379" });
    expect(options.tls).toBeUndefined();
  });

  it(".env'den gelen tirnaklari soyar", () => {
    const { url } = redisOptionsFromEnv({ REDIS_URL: '"rediss://example.test:6380"' });
    expect(url).toBe("rediss://example.test:6380");
  });

  it("hizli ve sinirli hata icin zaman asimlarini ayarlar", () => {
    const { options } = redisOptionsFromEnv({ REDIS_URL: "redis://localhost:6379" });
    expect(options.connectTimeout).toBeGreaterThan(0);
    expect(options.connectTimeout).toBeLessThanOrEqual(5_000);
    expect(options.commandTimeout).toBeGreaterThan(0);
    expect(options.commandTimeout).toBeLessThanOrEqual(5_000);
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options.retryStrategy).toBe(reconnectDelayMs);
  });
});

describe("reconnectDelayMs()", () => {
  it("artar, ust sinirda kalir ve hic null donmez", () => {
    expect(reconnectDelayMs(1)).toBe(200);
    expect(reconnectDelayMs(5)).toBe(1_000);
    expect(reconnectDelayMs(1_000)).toBe(2_000);
  });
});

describe("isRedisUnavailableError()", () => {
  it("yalnizca RedisUnavailableError'u tanir", () => {
    expect(isRedisUnavailableError(new RedisUnavailableError("x"))).toBe(true);
    expect(isRedisUnavailableError(new Error("x"))).toBe(false);
  });
});
