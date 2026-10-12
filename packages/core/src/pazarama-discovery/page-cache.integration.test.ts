/**
 * Ortak sayfa onbellegi, GERCEK yerel Redis ile. Pazarama'ya istek ATILMAZ. Her test kendi
 * rastgele URL'sini kullanir ve sonunda anahtarlarini siler.
 */
import { afterAll, describe, expect, it } from "vitest";
import { getRedis } from "../redis/client.ts";
import { pageCacheKey, RedisPageCache } from "./page-cache.ts";

const keys: string[] = [];
function key(): string {
  const k = pageCacheKey("detail", `https://test.invalid/${Date.now()}-${Math.random()}`, true);
  keys.push(k, `${k}:lock`);
  return k;
}

afterAll(async () => {
  if (keys.length > 0) await getRedis().del(...keys);
  getRedis().disconnect();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const page = {
  status: 200,
  body: "<html>ö ü ğ ₺</html>",
  location: null,
  fetchedAt: 1_700_000_000_000,
};

describe("RedisPageCache (yerel Redis)", () => {
  it("saklar, aynen dondurur (UTF-8), TTL dolunca duser", async () => {
    const c = new RedisPageCache(getRedis());
    const k = key();
    await c.set(k, page, 300);
    expect(await c.get(k)).toEqual(page);
    await sleep(400);
    expect(await c.get(k)).toBeNull();
  });

  it("TTL 0 saklamaz", async () => {
    const c = new RedisPageCache(getRedis());
    const k = key();
    await c.set(k, page, 0);
    expect(await c.get(k)).toBeNull();
  });

  it("single-flight kilidi: iki instance'tan yalnizca biri alir; birakilinca ya da sure dolunca yeniden alinir", async () => {
    const a = new RedisPageCache(getRedis());
    const b = new RedisPageCache(getRedis());
    const k = key();
    const got = await Promise.all([a.lock(k, 5_000), b.lock(k, 5_000)]);
    expect(got.filter(Boolean)).toHaveLength(1);
    await a.unlock(k);
    expect(await b.lock(k, 200)).toBe(true);
    await sleep(300); // kilit sahibi coktu: PX ile duser
    expect(await a.lock(k, 5_000)).toBe(true);
  });
});
