import { describe, expect, it } from "vitest";
import { type CollectorEnv, runCollection, searchUrl } from "./collector-logic.ts";

// Sahte ortam: ag ve sunucu yok, sentetik sayfalar. Hepsiburada'ya istek ATILMAZ.
const item = (id: string) => ({
  externalId: id,
  title: `Urun ${id}`,
  url: `https://www.hepsiburada.com/u-p-${id}`,
  priceMinor: 1000,
  currency: "TRY" as const,
  inStock: true,
  imageUrl: null,
  brand: null,
});

function fakeEnv(pages: Record<string, { status: number; ids?: string[]; noStructure?: boolean }>) {
  const calls: { fetch: string[]; api: Record<string, unknown>[]; sleeps: number[] } = {
    fetch: [],
    api: [],
    sleeps: [],
  };
  let stopAfter = Number.POSITIVE_INFINITY;
  const env: CollectorEnv = {
    source: "hepsiburada",
    delayMs: 3000,
    now: () => new Date("2026-10-20T10:00:00Z"),
    log: () => {},
    shouldStop: () => calls.fetch.length >= stopAfter,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    async fetchPage(url) {
      calls.fetch.push(url);
      const p = pages[url] ?? { status: 200, ids: [] };
      return { status: p.status, text: JSON.stringify(p) };
    },
    extract(html) {
      const p = JSON.parse(html) as { ids?: string[]; noStructure?: boolean };
      if (p.noStructure) return { items: [], rawCount: 0, structureFound: false };
      const items = (p.ids ?? []).map(item);
      return { items, rawCount: items.length, structureFound: true };
    },
    async api(body) {
      calls.api.push(body);
      if (body.op === "start") {
        return { ok: true, status: 200, data: { id: 9, maxRequests: 5 } };
      }
      if (body.op === "batch") {
        const n = (body.records as unknown[]).length;
        return { ok: true, status: 200, data: { inserted: n, duplicates: 0, rejected: 0 } };
      }
      return {
        ok: true,
        status: 200,
        data: {
          uniqueRecords: 0,
          queries: 0,
          pagesFetched: 0,
          queriesCappedByPageLimit: 0,
          queriesPaginationUnconfirmed: 0,
        },
      };
    },
  };
  return { env, calls, stopAfter: (n: number) => (stopAfter = n) };
}

describe("runCollection", () => {
  it("sayfalar, bekler, kosuyu kapatir ve sayfa tavanini isaretler", async () => {
    const { env, calls } = fakeEnv({
      [searchUrl("a", 1)]: { status: 200, ids: ["1", "2"] },
      [searchUrl("a", 2)]: { status: 200, ids: ["3"] },
    });
    const reason = await runCollection(env, { queries: ["a"], maxPages: 2, resumeRun: null });
    expect(reason).toBe("completed");
    expect(calls.fetch).toEqual([searchUrl("a", 1), searchUrl("a", 2)]);
    expect(calls.sleeps).toEqual([3000]); // istekler arasi bekleme, ilkinden once degil
    expect(calls.api.map((b) => b.op)).toEqual(["start", "batch", "batch", "close"]);
    expect(calls.api[2]?.requestsMade).toBe(2);
  });

  it("onceki sayfalarda gorulmemis urun gelmiyorsa sayfalamayi birakir", async () => {
    const { env, calls } = fakeEnv({
      [searchUrl("a", 1)]: { status: 200, ids: ["1", "2"] },
      [searchUrl("a", 2)]: { status: 200, ids: ["1", "2"] }, // ayni sayfa: sayfalama calismiyor
    });
    await runCollection(env, { queries: ["a"], maxPages: 10, resumeRun: null });
    expect(calls.fetch).toHaveLength(2);
  });

  it("403/429/503 ya da yapi yoksa DURUR; yeniden denemez, sonraki sorguya gecmez", async () => {
    for (const bad of [
      { status: 403 },
      { status: 429 },
      { status: 503 },
      { status: 200, noStructure: true },
    ]) {
      const { env, calls } = fakeEnv({ [searchUrl("a", 1)]: bad });
      const reason = await runCollection(env, {
        queries: ["a", "b"],
        maxPages: 3,
        resumeRun: null,
      });
      expect(reason).toBe("blocked");
      expect(calls.fetch).toEqual([searchUrl("a", 1)]);
      const batch = calls.api.find((b) => b.op === "batch");
      const unit = ((batch?.units ?? []) as { status: string }[])[0];
      expect(unit?.status).toBe("blocked");
      expect((calls.api.at(-1) as { outcome: string }).outcome).toBe("aborted");
    }
  });

  it("istek butcesi dolunca durur", async () => {
    const pages: Record<string, { status: number; ids: string[] }> = {};
    for (let p = 1; p <= 10; p++)
      pages[searchUrl("a", p)] = { status: 200, ids: [`${p}x`, `${p}y`] };
    const { env, calls } = fakeEnv(pages); // butce: 5
    const reason = await runCollection(env, { queries: ["a"], maxPages: 10, resumeRun: null });
    expect(reason).toBe("budget");
    expect(calls.fetch).toHaveLength(5);
  });

  it("duraklatilinca kosu acik kalir; devam edince kaldigi sayfadan surer", async () => {
    const pages: Record<string, { status: number; ids: string[] }> = {
      [searchUrl("a", 1)]: { status: 200, ids: ["1"] },
      [searchUrl("a", 2)]: { status: 200, ids: ["2"] },
      [searchUrl("a", 3)]: { status: 200, ids: ["3"] },
    };
    const first = fakeEnv(pages);
    first.stopAfter(1);
    const reason = await runCollection(first.env, { queries: ["a"], maxPages: 3, resumeRun: null });
    expect(reason).toBe("paused");
    expect(first.calls.api.some((b) => b.op === "close")).toBe(false);
    const checkpoint = first.calls.api.filter((b) => b.op === "batch").at(-1)?.checkpoint as Record<
      string,
      unknown
    >;

    const second = fakeEnv(pages);
    await runCollection(second.env, {
      queries: ["a"],
      maxPages: 3,
      resumeRun: { id: 9, requestsMade: 1, maxRequests: 5, checkpoint },
    });
    expect(second.calls.fetch).toEqual([searchUrl("a", 2), searchUrl("a", 3)]);
    expect(second.calls.api[0]?.op).toBe("batch"); // yeni kosu (start) acilmaz
  });

  it("sunucu partiyi reddederse durur", async () => {
    const { env } = fakeEnv({ [searchUrl("a", 1)]: { status: 200, ids: ["1"] } });
    env.api = async (body) =>
      body.op === "start"
        ? { ok: true, status: 200, data: { id: 1, maxRequests: 5 } }
        : { ok: false, status: 429, data: { error: "request_budget_exceeded" } };
    expect(await runCollection(env, { queries: ["a"], maxPages: 2, resumeRun: null })).toBe(
      "error",
    );
  });

  it("kota reddi kosu baslatmaz ve kaynaga istek atmaz", async () => {
    const { env, calls } = fakeEnv({});
    env.api = async () => ({
      ok: false,
      status: 429,
      data: { error: "collection_quota_interval" },
    });
    expect(await runCollection(env, { queries: ["a"], maxPages: 2, resumeRun: null })).toBe(
      "error",
    );
    expect(calls.fetch).toHaveLength(0);
  });
});
