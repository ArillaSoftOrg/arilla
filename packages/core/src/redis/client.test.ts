import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLinkRedis,
  getRedis,
  hasDedicatedLinkRedis,
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

  // Karar 0109: VPS'te Redis Docker ic agindadir; VERCEL_ENV yoktur.
  it("DEPLOY_ENV=production: duz redis:// varsayilan olarak reddedilir", () => {
    const REDIS_URL = "redis://:gizli-parola@redis:6379";
    expect(() => redisOptionsFromEnv({ REDIS_URL, DEPLOY_ENV: "production" })).toThrow(
      RedisConfigError,
    );
    try {
      redisOptionsFromEnv({ REDIS_URL, DEPLOY_ENV: "production" });
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/gizli|redis:6379/);
    }
  });

  it("DEPLOY_ENV=production: yalnizca REDIS_PLAINTEXT_HOSTS listesindeki host duz redis:// alir", () => {
    const base = { DEPLOY_ENV: "production", REDIS_PLAINTEXT_HOSTS: "redis, Cache" };
    expect(redisOptionsFromEnv({ ...base, REDIS_URL: "redis://:p@redis:6379" }).url).toBe(
      "redis://:p@redis:6379",
    );
    expect(redisOptionsFromEnv({ ...base, REDIS_URL: "redis://:p@cache:6379" }).options.tls).toBe(
      undefined,
    );
    // Listede olmayan (dis) host hala TLS ister.
    expect(() =>
      redisOptionsFromEnv({ ...base, REDIS_URL: "redis://:p@eu1.upstash.io:6379" }),
    ).toThrow(RedisConfigError);
  });

  it("izin listesi bos ya da gecersizse hicbir host muaf degildir", () => {
    for (const REDIS_PLAINTEXT_HOSTS of ["", " , ", undefined]) {
      expect(() =>
        redisOptionsFromEnv({
          REDIS_URL: "redis://:p@redis:6379",
          DEPLOY_ENV: "production",
          REDIS_PLAINTEXT_HOSTS,
        }),
      ).toThrow(RedisConfigError);
    }
  });

  it("izin listesi Vercel production'da da yalnizca acikca yazilan host'u muaf tutar", () => {
    expect(() =>
      redisOptionsFromEnv({ REDIS_URL: "redis://:p@redis:6379", VERCEL_ENV: "production" }),
    ).toThrow(RedisConfigError);
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

describe("redisOptionsFromEnv() - LINK_REDIS_URL", () => {
  it("hata mesajı okunan değişkenin adını taşır, adresi taşımaz", () => {
    expect(() => redisOptionsFromEnv({}, "LINK_REDIS_URL")).toThrow(
      /^LINK_REDIS_URL tanimli degil/,
    );
    expect(() => redisOptionsFromEnv({ LINK_REDIS_URL: "http://x" }, "LINK_REDIS_URL")).toThrow(
      /^LINK_REDIS_URL redis:\/\/ ya da rediss:\/\/ ile baslamali/,
    );
    const error = (() => {
      try {
        redisOptionsFromEnv(
          { LINK_REDIS_URL: "redis://:gizli@redis:6379", DEPLOY_ENV: "production" },
          "LINK_REDIS_URL",
        );
      } catch (e) {
        return e as Error;
      }
      throw new Error("firlatilmadi");
    })();
    expect(error.message).toMatch(/^LINK_REDIS_URL production ortaminda rediss/);
    expect(error.message).not.toContain("gizli");
    expect(error.message).not.toContain("redis:6379");
  });

  it("production'da düz redis:// yalnızca REDIS_PLAINTEXT_HOSTS'taki host'a izin verir", () => {
    const base = { DEPLOY_ENV: "production", LINK_REDIS_URL: "redis://:p@redis:6379" };
    expect(() => redisOptionsFromEnv(base, "LINK_REDIS_URL")).toThrow(RedisConfigError);
    expect(() =>
      redisOptionsFromEnv({ ...base, REDIS_PLAINTEXT_HOSTS: "baska" }, "LINK_REDIS_URL"),
    ).toThrow(RedisConfigError);
    expect(
      redisOptionsFromEnv({ ...base, REDIS_PLAINTEXT_HOSTS: "redis" }, "LINK_REDIS_URL").url,
    ).toBe(base.LINK_REDIS_URL);
  });

  it("REDIS_URL'i okumaz: yalnızca LINK_REDIS_URL kullanılır", () => {
    const config = redisOptionsFromEnv(
      { REDIS_URL: "redis://localhost:1111", LINK_REDIS_URL: "redis://localhost:2222" },
      "LINK_REDIS_URL",
    );
    expect(config.url).toBe("redis://localhost:2222");
  });
});

describe("hasDedicatedLinkRedis()", () => {
  it("yalnızca boş olmayan LINK_REDIS_URL ayrı bağlantı sayılır", () => {
    expect(hasDedicatedLinkRedis({})).toBe(false);
    expect(hasDedicatedLinkRedis({ LINK_REDIS_URL: "" })).toBe(false);
    expect(hasDedicatedLinkRedis({ LINK_REDIS_URL: "   " })).toBe(false);
    expect(hasDedicatedLinkRedis({ LINK_REDIS_URL: "redis://redis:6379" })).toBe(true);
  });
});

describe("getLinkRedis()", () => {
  const holder = globalThis as typeof globalThis & {
    __arillaRedis?: { disconnect(): void };
    __arillaLinkRedis?: { disconnect(): void };
  };

  afterEach(() => {
    holder.__arillaRedis?.disconnect();
    holder.__arillaLinkRedis?.disconnect();
    holder.__arillaRedis = undefined;
    holder.__arillaLinkRedis = undefined;
    vi.unstubAllEnvs();
  });

  it("LINK_REDIS_URL yokken getRedis() ile aynı bağlantıdır (eski davranış)", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("LINK_REDIS_URL", "");
    expect(getLinkRedis()).toBe(getRedis());
    expect(holder.__arillaLinkRedis).toBeUndefined();
  });

  it("LINK_REDIS_URL varken ayrı, önbellekli bir istemci kurar; getRedis() değişmez", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("LINK_REDIS_URL", "redis://localhost:6380");
    const link = getLinkRedis();
    const general = getRedis();
    expect(link).not.toBe(general);
    expect(getLinkRedis()).toBe(link);
    expect(getRedis()).toBe(general);
    expect(link.options.port).toBe(6380);
    expect(general.options.port).toBe(6379);
    // Bağlantı lazy: hiçbir soket açılmadı.
    expect(link.status).toBe("wait");
  });

  it("LINK_REDIS_URL geçersizse yapılandırma hatası (sessizce REDIS_URL'e düşmez)", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("LINK_REDIS_URL", "http://yanlis");
    expect(() => getLinkRedis()).toThrow(RedisConfigError);
  });
});
