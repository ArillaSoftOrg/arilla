/**
 * Cok pencereli kota, GERCEK yerel Redis ile: Lua betiginin hepsi-ya-hicbiri
 * davranisi, pencere sifirlanmasi, iade ve TTL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getRedis } from "../redis/client.ts";
import { QUOTA_POLICY, QUOTA_WINDOWS, type QuotaPool } from "./policy.ts";
import { consumeQuota, quotaKey, releaseQuota } from "./redis-windows.ts";

const run = randomUUID().slice(0, 8);
const usedKeys = new Set<string>();
const NOW = new Date("2026-10-08T16:30:00Z");
const SMALL = { hour: 2, day: 3, week: 4, month: 5 } as const;

function subject(name: string): string {
  return `user:test-${run}-${name}`;
}

function track(pool: QuotaPool, name: string, now: Date) {
  for (const window of QUOTA_WINDOWS) usedKeys.add(quotaKey(pool, window, now, subject(name)));
}

async function consume(name: string, now: Date, limits = SMALL, pool: QuotaPool = "chat_message") {
  track(pool, name, now);
  return consumeQuota({ pool, subject: subject(name), now, limits });
}

afterAll(async () => {
  if (usedKeys.size > 0) await getRedis().del(...usedKeys);
  getRedis().disconnect();
});

describe("consumeQuota (Redis)", () => {
  it("saatlik sinir dolunca reddeder; reddedilen istek hicbir pencereyi artirmaz", async () => {
    expect(await consume("hour", NOW)).toEqual({ allowed: true });
    expect(await consume("hour", NOW)).toEqual({ allowed: true });
    for (let i = 0; i < 3; i++) {
      expect(await consume("hour", NOW)).toEqual({ allowed: false, window: "hour" });
    }
    const redis = getRedis();
    for (const window of QUOTA_WINDOWS) {
      expect(await redis.get(quotaKey("chat_message", window, NOW, subject("hour")))).toBe("2");
    }
  });

  it("saat yenilenince gunluk sinir gecerli olur, sonra hafta, sonra ay", async () => {
    const h0 = NOW;
    const h1 = new Date(NOW.getTime() + 60 * 60 * 1000);
    const nextDay = new Date("2026-10-09T08:00:00Z");
    const nextWeek = new Date("2026-10-13T08:00:00Z");
    expect(await consume("windows", h0)).toEqual({ allowed: true });
    expect(await consume("windows", h0)).toEqual({ allowed: true });
    expect(await consume("windows", h0)).toEqual({ allowed: false, window: "hour" });
    expect(await consume("windows", h1)).toEqual({ allowed: true });
    expect(await consume("windows", h1)).toEqual({ allowed: false, window: "day" });
    expect(await consume("windows", nextDay)).toEqual({ allowed: true });
    expect(await consume("windows", nextDay)).toEqual({ allowed: false, window: "week" });
    expect(await consume("windows", nextWeek)).toEqual({ allowed: true });
    expect(await consume("windows", nextWeek)).toEqual({ allowed: false, window: "month" });
  });

  it("ozneler ve havuzlar birbirinden bagimsiz", async () => {
    for (let i = 0; i < 2; i++) await consume("a", NOW);
    expect(await consume("a", NOW)).toEqual({ allowed: false, window: "hour" });
    expect(await consume("b", NOW)).toEqual({ allowed: true });
    expect(await consume("a", NOW, SMALL, "realtime_interpretation_user")).toEqual({
      allowed: true,
    });
  });

  it("esanli istekler sinirin ustune cikamaz", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => consume("burst", NOW)));
    expect(results.filter((r) => r.allowed)).toHaveLength(SMALL.hour);
  });

  it("iade harcamayi geri verir ve sifirin altina inmez", async () => {
    await consume("release", NOW);
    await consume("release", NOW);
    expect(await consume("release", NOW)).toEqual({ allowed: false, window: "hour" });
    await releaseQuota({ pool: "chat_message", subject: subject("release"), now: NOW });
    expect(await consume("release", NOW)).toEqual({ allowed: true });
    for (let i = 0; i < 5; i++) {
      await releaseQuota({ pool: "chat_message", subject: subject("release"), now: NOW });
    }
    const key = quotaKey("chat_message", "hour", NOW, subject("release"));
    expect(await getRedis().get(key)).toBe("0");
  });

  it("anahtarlar donem sonuna kadar (+pay) yasar", async () => {
    const now = new Date();
    await consume("ttl", now);
    const ttl = await getRedis().ttl(quotaKey("chat_message", "hour", now, subject("ttl")));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 60);
  });

  it("varsayilan limitler politikadan gelir", async () => {
    const name = "policy";
    track("realtime_interpretation_anonymous", name, NOW);
    const limit = QUOTA_POLICY.realtime_interpretation_anonymous.hour;
    for (let i = 0; i < limit; i++) {
      const result = await consumeQuota({
        pool: "realtime_interpretation_anonymous",
        subject: subject(name),
        now: NOW,
      });
      expect(result.allowed).toBe(true);
    }
    expect(
      await consumeQuota({
        pool: "realtime_interpretation_anonymous",
        subject: subject(name),
        now: NOW,
      }),
    ).toEqual({ allowed: false, window: "hour" });
  });
});
