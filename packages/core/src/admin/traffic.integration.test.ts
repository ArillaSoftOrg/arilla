/**
 * GA4 trafik önbelleği (karar 0087) — gerçek Redis. Ağ yok: sahte taşıyıcı.
 * Doğrulananlar: taze kopya TTL'si (tamamlanmış aralık 6 saat), eski kopya
 * 7 gün, kota anlık görüntüsü; ikinci istek önbellekten; anahtarlarda mülk
 * kimliği açık yazılmaz. Test mülkü benzersizdir, anahtarları sonunda silinir.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { parseTrafficRange } from "../analytics-ga4/reports.ts";
import { getRedis } from "../redis/client.ts";
import { getTrafficSummary, redisTrafficCacheStore } from "./traffic.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PROPERTY = String(100_000_000 + Math.floor(Math.random() * 800_000_000));
const ENV = {
  GA4_PROPERTY_ID: PROPERTY,
  GA4_CLIENT_EMAIL: "rapor-okur@ornek-proje.iam.gserviceaccount.com",
  GA4_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const PREFIX = `ga4:v1:${createHash("sha256").update(PROPERTY).digest("hex").slice(0, 12)}:`;

let apiCalls = 0;
const transport = {
  now: () => Date.now(),
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/token")) {
      return new Response(
        JSON.stringify({ access_token: "sahte-belirtec-123456", expires_in: 3600 }),
      );
    }
    apiCalls += 1;
    const { requests } = JSON.parse(String(init?.body)) as { requests: unknown[] };
    return new Response(
      JSON.stringify({
        reports: requests.map(() => ({
          rows: [
            {
              metricValues: [
                { value: "12" },
                { value: "3" },
                { value: "20" },
                { value: "40" },
                { value: "0.5" },
              ],
            },
          ],
          propertyQuota: { tokensPerHour: { consumed: 5, remaining: 39_000 } },
        })),
      }),
    );
  }) as typeof fetch,
};

afterAll(async () => {
  const redis = getRedis();
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
});

describe("GA4 trafik önbelleği - gerçek Redis", () => {
  it("taze/eski/kota anahtarları doğru TTL ile; ikinci istek ağa gitmez", async () => {
    const range = parseTrafficRange({ gun: "7" }, new Date());
    const deps = { env: ENV, transport, store: redisTrafficCacheStore() };
    const first = await getTrafficSummary({ userId: 1, role: "admin" }, { range }, deps);
    expect(first.state).toBe("ok");
    expect(apiCalls).toBe(1);
    const second = await getTrafficSummary({ userId: 1, role: "admin" }, { range }, deps);
    expect(second.state === "ok" && second.cached).toBe(true);
    expect(apiCalls).toBe(1);
    if (second.state === "ok") expect(second.data.totals.current.users).toBe(12);

    const redis = getRedis();
    const keys = await redis.keys(`${PREFIX}*`);
    expect(keys.length).toBe(3);
    for (const key of keys) expect(key).not.toContain(PROPERTY);
    const fresh = keys.find((k) => !k.endsWith(":stale") && !k.endsWith(":quota")) ?? "";
    const stale = keys.find((k) => k.endsWith(":stale")) ?? "";
    const quota = keys.find((k) => k.endsWith(":quota")) ?? "";
    const freshTtl = await redis.ttl(fresh);
    expect(freshTtl).toBeGreaterThan(5 * 60 * 60);
    expect(freshTtl).toBeLessThanOrEqual(6 * 60 * 60);
    expect(await redis.ttl(stale)).toBeGreaterThan(6 * 24 * 60 * 60);
    expect(await redis.ttl(quota)).toBeLessThanOrEqual(60 * 60);
    expect(JSON.parse((await redis.get(quota)) ?? "{}")).toMatchObject({ hourRemaining: 39_000 });
  });
});
