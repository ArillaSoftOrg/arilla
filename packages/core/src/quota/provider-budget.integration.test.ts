/**
 * Saglayici butcesi, GERCEK yerel Redis ile: atomik ayirma, tavan, gun siniri,
 * iade/kesinlestirme ve islemler arasi yalitim. Gercek gunun sayaclarina
 * dokunmamak icin uzak bir test gunu kullanilir.
 */
import { afterAll, describe, expect, it } from "vitest";
import { getRedis, RedisUnavailableError } from "../redis/client.ts";
import {
  type ProviderBudgetOperation,
  providerBudgetKey,
  reserveProviderBudget,
  settleProviderBudget,
} from "./provider-budget.ts";

/** 2101-03-10 Istanbul ogleden sonra; her test kendi gununu kullanir. */
function day(offset: number, hourUtc = 12): Date {
  return new Date(Date.UTC(2101, 2, 10 + offset, hourUtc, 0, 0));
}

const usedKeys = new Set<string>();
function track(operation: ProviderBudgetOperation, now: Date): string {
  const key = providerBudgetKey(operation, now);
  usedKeys.add(key);
  return key;
}

async function value(key: string): Promise<number> {
  return Number((await getRedis().get(key)) ?? 0);
}

afterAll(async () => {
  if (usedKeys.size > 0) await getRedis().del(...usedKeys);
  getRedis().disconnect();
});

describe("reserveProviderBudget (Redis)", () => {
  it("anahtar yalnizca islem ve Istanbul gunu tasir; gun sonu + pay kadar yasar", async () => {
    const now = day(0);
    const key = track("chat_turn", now);
    expect(key).toBe("provider-budget:chat_turn:2101-03-10");
    const result = await reserveProviderBudget({ operation: "chat_turn", amount: 1, cap: 5, now });
    expect(result.allowed).toBe(true);
    const ttl = await getRedis().ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 + 6 * 60 * 60);
  });

  it("esanli ayirmalar tavani asamaz", async () => {
    const now = day(1);
    const key = track("query_interpretation_realtime", now);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        reserveProviderBudget({
          operation: "query_interpretation_realtime",
          amount: 1,
          cap: 20,
          now,
        }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(await value(key)).toBe(20);
  });

  it("cok denemeli ayirma tavani bolmez: 2'lik ayirma 1 bos yerde reddedilir, hicbir sey yazilmaz", async () => {
    const now = day(2);
    const key = track("chat_turn", now);
    expect(
      (await reserveProviderBudget({ operation: "chat_turn", amount: 2, cap: 3, now })).allowed,
    ).toBe(true);
    expect(await reserveProviderBudget({ operation: "chat_turn", amount: 2, cap: 3, now })).toEqual(
      {
        allowed: false,
      },
    );
    expect(await value(key)).toBe(2);
  });

  it("anlik yorum ve sohbet sayaclari birbirinden bagimsiz", async () => {
    const now = day(3);
    const realtimeKey = track("query_interpretation_realtime", now);
    const chatKey = track("chat_turn", now);
    await reserveProviderBudget({
      operation: "query_interpretation_realtime",
      amount: 1,
      cap: 1,
      now,
    });
    expect(
      (
        await reserveProviderBudget({
          operation: "query_interpretation_realtime",
          amount: 1,
          cap: 1,
          now,
        })
      ).allowed,
    ).toBe(false);
    expect(
      (await reserveProviderBudget({ operation: "chat_turn", amount: 1, cap: 1, now })).allowed,
    ).toBe(true);
    expect([await value(realtimeKey), await value(chatKey)]).toEqual([1, 1]);
  });

  it("Istanbul gece yarisinda (UTC 21:00) yeni gun baslar", async () => {
    const beforeMidnight = new Date(Date.UTC(2101, 2, 20, 20, 59, 59));
    const afterMidnight = new Date(Date.UTC(2101, 2, 20, 21, 0, 0));
    track("chat_turn", beforeMidnight);
    track("chat_turn", afterMidnight);
    expect(providerBudgetKey("chat_turn", beforeMidnight)).toBe(
      "provider-budget:chat_turn:2101-03-20",
    );
    expect(providerBudgetKey("chat_turn", afterMidnight)).toBe(
      "provider-budget:chat_turn:2101-03-21",
    );
    await reserveProviderBudget({ operation: "chat_turn", amount: 1, cap: 1, now: beforeMidnight });
    expect(
      (
        await reserveProviderBudget({
          operation: "chat_turn",
          amount: 1,
          cap: 1,
          now: beforeMidnight,
        })
      ).allowed,
    ).toBe(false);
    expect(
      (
        await reserveProviderBudget({
          operation: "chat_turn",
          amount: 1,
          cap: 1,
          now: afterMidnight,
        })
      ).allowed,
    ).toBe(true);
  });

  it("saglayici hic cagrilmadiysa ayrilan tamamen iade edilir", async () => {
    const now = day(4);
    const key = track("chat_turn", now);
    const result = await reserveProviderBudget({ operation: "chat_turn", amount: 2, cap: 2, now });
    if (!result.allowed) throw new Error("ayrilmaliydi");
    await settleProviderBudget(result.reservation, 0);
    expect(await value(key)).toBe(0);
    expect(
      (await reserveProviderBudget({ operation: "chat_turn", amount: 2, cap: 2, now })).allowed,
    ).toBe(true);
  });

  it("saglayici cagrildiysa (hata donse de) gercek deneme sayisi kalir; fazlasi da sayilir", async () => {
    const now = day(5);
    const key = track("chat_turn", now);
    const one = await reserveProviderBudget({ operation: "chat_turn", amount: 2, cap: 10, now });
    if (!one.allowed) throw new Error("ayrilmaliydi");
    await settleProviderBudget(one.reservation, 1); // 1 deneme yapildi (hata donmus olabilir)
    expect(await value(key)).toBe(1);
    const two = await reserveProviderBudget({ operation: "chat_turn", amount: 1, cap: 10, now });
    if (!two.allowed) throw new Error("ayrilmaliydi");
    await settleProviderBudget(two.reservation, 3); // ayrilandan fazla deneme: sayilir
    expect(await value(key)).toBe(4);
  });

  it("kesinlestirme ayirmanin gunune yazar; iade sifirin altina inmez", async () => {
    const now = day(6);
    const key = track("query_interpretation_realtime", now);
    const result = await reserveProviderBudget({
      operation: "query_interpretation_realtime",
      amount: 1,
      cap: 5,
      now,
    });
    if (!result.allowed) throw new Error("ayrilmaliydi");
    await getRedis().set(key, "0", "KEEPTTL");
    await settleProviderBudget(result.reservation, 0);
    expect(await value(key)).toBe(0);
  });

  it("Redis hatasi RedisUnavailableError olarak cagirana gecer", async () => {
    const broken = {
      eval: async () => {
        throw new Error("baglanti yok");
      },
    };
    await expect(
      reserveProviderBudget({ operation: "chat_turn", amount: 1, cap: 5, now: day(7) }, broken),
    ).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
