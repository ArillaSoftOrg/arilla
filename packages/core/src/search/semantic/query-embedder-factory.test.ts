import type { Database } from "@arilla/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERYABLE_INDEXES, type SemanticIndex } from "./active-index.ts";
import canaryJson from "./golden/bge-m3-5617a9f6-query-canary.json" with { type: "json" };
import { canaryStatus, type QueryCanaryData, resetCanaryGates } from "./query-canary.ts";
import { createQueryEmbedderForIndex } from "./query-embedder-factory.ts";

const GOLDEN = canaryJson as unknown as QueryCanaryData;
const BGE = QUERYABLE_INDEXES["bge-m3-5617a9f6"] as SemanticIndex;
const JINA = QUERYABLE_INDEXES["jina-embeddings-v3"] as SemanticIndex;
const ENV = { EMBED_BGE_M3_QUERY_URL: "http://embed-query:8080" };

function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        rows.push(row);
      },
    }),
  } as unknown as Database;
  return { db, rows };
}

/** Servis taklidi: altin metinlere referans vektoru, digerlerine sabit birim vektor doner. */
function stubService(mode: "correct" | "wrong_pooling") {
  const calls: { text: string }[] = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    const text = body.input[0] as string;
    calls.push({ text });
    const golden = GOLDEN.cases.find((c) => c.text === text);
    let vector: number[];
    if (golden && mode === "correct") vector = golden.vector;
    else if (golden) {
      // farkli uzay: ayni boyut ve norm, ama referanstan uzak (ters cevrilmis)
      vector = [...golden.vector].reverse();
    } else {
      vector = new Array<number>(1024).fill(0);
      vector[3] = 1;
    }
    return new Response(
      JSON.stringify({
        model: "BAAI/bge-m3",
        data: [{ embedding: vector }],
        usage: { total_tokens: 11 },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

beforeEach(() => resetCanaryGates());
afterEach(() => {
  vi.unstubAllGlobals();
  resetCanaryGates();
});

describe("saglayici secimi", () => {
  it("jina: anahtar yoksa null/no_api_key; varsa embedder", () => {
    expect(createQueryEmbedderForIndex(fakeDb().db, {}, JINA)).toEqual({
      embedder: null,
      reason: "no_api_key",
    });
    expect(
      createQueryEmbedderForIndex(fakeDb().db, { JINA_API_KEY: "k" }, JINA).embedder,
    ).not.toBeNull();
  });

  it("remote_http: adres yok/gecersiz/herkese acik HTTP -> no_endpoint", () => {
    for (const env of [
      {},
      { EMBED_BGE_M3_QUERY_URL: "" },
      { EMBED_BGE_M3_QUERY_URL: "http://embed.example.com" },
      { EMBED_BGE_M3_QUERY_URL: "https://user:p@embed.example.com" },
      // toplu is adresi sorgu servisi olarak KULLANILMAZ
      { EMBED_BGE_M3_URL: "http://embed-cpu:8080" },
    ]) {
      expect(createQueryEmbedderForIndex(fakeDb().db, env, BGE)).toEqual({
        embedder: null,
        reason: "no_endpoint",
      });
    }
  });

  it("kanarya kaydi olmayan remote model sunulamaz (no_canary)", () => {
    const other: SemanticIndex = { ...BGE, modelVersion: "baska-model-1" };
    expect(createQueryEmbedderForIndex(fakeDb().db, ENV, other)).toEqual({
      embedder: null,
      reason: "no_canary",
    });
  });
});

describe("BGE-M3 sorgu servisi + kanarya kapisi", () => {
  it("kapi gecene kadar vektor yok; sonra gercek vektor ve maliyetsiz api_usage satiri", async () => {
    const svc = stubService("correct");
    const { db, rows } = fakeDb();
    const { embedder } = createQueryEmbedderForIndex(db, ENV, BGE);
    expect(embedder).not.toBeNull();
    // Ilk istek: kanarya arka planda baslar, istek BEKLEMEZ ve vektor donmez.
    expect(await embedder?.embedQuery("kablosuz kulaklik")).toBeNull();
    await vi.waitFor(() => expect(canaryStatus()["bge-m3-5617a9f6"]?.state).toBe("passed"));
    const status = canaryStatus()["bge-m3-5617a9f6"];
    expect(status?.minCosine).toBeGreaterThan(0.9999);
    const got = await embedder?.embedQuery("kablosuz kulaklik");
    expect(got?.vector).toHaveLength(1024);
    expect(got?.cacheHit).toBe(false);
    // Kanarya cagrilari api_usage'a yazilmaz; yalniz gercek sorgu.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "semantic_query_embedding",
      modelVersion: "bge-m3-5617a9f6",
      units: 11,
      costMicros: 0,
      cacheHit: false,
    });
    // Sorgu metni onceki altin metinlerden ayri bir cagridir.
    expect(svc.calls.filter((c) => c.text === "kablosuz kulaklik")).toHaveLength(1);
  });

  it("yanlis uzay (ornek yanlis havuzlama): kanarya BASARISIZ, hicbir gercek vektor kullanilmaz", async () => {
    stubService("wrong_pooling");
    const { db, rows } = fakeDb();
    const { embedder } = createQueryEmbedderForIndex(db, ENV, BGE);
    expect(await embedder?.embedQuery("laptop")).toBeNull();
    await vi.waitFor(() => expect(canaryStatus()["bge-m3-5617a9f6"]?.state).toBe("failed"));
    expect(await embedder?.embedQuery("laptop")).toBeNull();
    expect(await embedder?.embedQuery("baska sorgu")).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("servis kapaliyken kanarya basarisiz; arama etkilenmez (null)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { embedder } = createQueryEmbedderForIndex(fakeDb().db, ENV, BGE);
    expect(await embedder?.embedQuery("laptop")).toBeNull();
    await vi.waitFor(() => expect(canaryStatus()["bge-m3-5617a9f6"]?.state).toBe("failed"));
  });
});
