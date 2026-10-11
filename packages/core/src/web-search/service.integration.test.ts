import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRedis } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { GroundedResponse, WebGroundingClient } from "./grounding-client.ts";
import { searchWeb } from "./service.ts";

/**
 * Gercek Redis (onbellek, tek ucus kilidi, kisi limiti, gunluk butce) ve gercek
 * Postgres (`api_usage`) uzerinde; yalnizca Gemini istemcisi sahte.
 */
const url = "https://a.com.tr/sony-wh-1000xm5";
// Rakam iceren uzun dizi kisisel veri suzgecine takilir; benzersizlik harflerle saglanir.
const RUN = Date.now()
  .toString(36)
  .replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)] as string);
let calls = 0;

const client: WebGroundingClient = {
  modelVersion: "gemini-3.5-flash-lite",
  async search(_request, options) {
    calls++;
    options?.onCall?.({
      modelVersion: "gemini-3.5-flash-lite",
      httpStatus: 200,
      usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 0, totalTokens: 15 },
    });
    const response: GroundedResponse = {
      text: JSON.stringify({
        results: [
          {
            title: "Sony WH-1000XM5 Siyah",
            brand: "Sony",
            url,
            pageType: "product",
            matchKind: "exact",
            price: { amount: 9999.9, currency: "TRY", evidence: "9.999,90 TL" },
            inStock: true,
          },
        ],
      }),
      citations: [{ url, title: "a.com.tr" }],
      searchQueries: ["sony wh-1000xm5 fiyat"],
      searchSuggestionsHtml: "<div>Google</div>",
      retrieved: [{ url, ok: true }],
      usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 0, totalTokens: 15 },
      modelVersion: "gemini-3.5-flash-lite",
    };
    return response;
  },
};

describe("searchWeb() - integration (gercek Redis + Postgres)", () => {
  const db = getTestDb();
  const userId = null;
  const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
  const fixedNow = new Date();

  beforeAll(async () => {
    // Onceki kosudan kalan bu IP/sorgu anahtarlarini temizle.
    const redis = getRedis();
    const keys = await redis.keys("websearch:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    const redis = getRedis();
    const keys = [...(await redis.keys("websearch:*")), ...(await redis.keys("wsf:*"))];
    if (keys.length > 0) await redis.del(...keys);
    await withOwnerClient((c) =>
      c.query("DELETE FROM api_usage WHERE operation LIKE 'web_search%'"),
    );
    getRedis().disconnect();
  });

  it("sonuclar onbelleklenmez; her arama model + grounding satiri yazar", async () => {
    const text = { kind: "text", text: `sony wh-1000xm5 siyah ${RUN}` } as const;
    const before = calls;
    const first = await searchWeb(db, text, { userId, ip }, { client, now: () => fixedNow });
    expect(first.status).toBe("ok");
    expect(first.searchSuggestionsHtml).toContain("Google");
    expect(first.groups[0]?.offers[0]?.priceStatus).toBe("verified");
    const second = await searchWeb(db, text, { userId, ip }, { client, now: () => fixedNow });
    expect(second.status).toBe("ok");
    expect(calls - before).toBe(2);

    const rows = await withOwnerClient((c) =>
      c.query(
        "SELECT operation, count(*)::int AS n, sum(units)::int AS units FROM api_usage WHERE operation LIKE 'web_search%' GROUP BY operation",
      ),
    );
    const byOp = Object.fromEntries(rows.rows.map((r) => [r.operation, r]));
    expect(byOp.web_search_grounded.n).toBe(2);
    expect(byOp.web_search_grounding_queries.units).toBe(2);
  });

  it("kisi basina saatlik limit asilinca model cagrilmaz", async () => {
    const actor = { userId, ip: `198.51.100.${Math.floor(Math.random() * 250)}` };
    const before = calls;
    const statuses: string[] = [];
    for (let i = 0; i < 10; i++) {
      const out = await searchWeb(
        db,
        { kind: "text", text: `sony wh-1000xm5 siyah model ${i} ${RUN}` },
        actor,
        { client, now: () => fixedNow },
      );
      statuses.push(out.status);
    }
    // 8 gercek cagri; sonraki ikisi limitli.
    expect(calls - before).toBe(8);
    expect(statuses.slice(0, 8).every((s) => s === "ok")).toBe(true);
    expect(statuses.slice(8)).toEqual(["limited", "limited"]);
  });

  it("gunluk butce 0 ise model cagrilmaz", async () => {
    const before = calls;
    const out = await searchWeb(
      db,
      { kind: "text", text: `butce testi urun ${RUN}` },
      { userId, ip: "192.0.2.77" },
      { client, dailyCallCap: 0, now: () => fixedNow },
    );
    expect(out.status).toBe("limited");
    expect(calls).toBe(before);
  });
});
