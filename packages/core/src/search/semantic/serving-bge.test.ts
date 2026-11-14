/**
 * BGE-M3 ile sunum (karar 0196): ayni `applySemanticServing`, model-bilincli birlestirme, uzak servis
 * hatalarinda metin sonucunun BIREBIR korunmasi. Veritabani ve ag sahte; gercek SQL ve HNSW
 * `serving-bge.integration.test.ts`te.
 */
import type { Database } from "@arilla/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RankedSearchItem } from "../fallback/types.ts";
import { QUERYABLE_INDEXES, type SemanticIndex } from "./active-index.ts";
import { createProviderHealth } from "./provider-health.ts";
import type { QueryEmbedder } from "./query-embedder.ts";
import { createRemoteQueryEmbedder } from "./remote-query-embedder.ts";
import {
  applySemanticServing,
  resetSemanticServingCounters,
  type ServingDeps,
  type ServingInput,
  type ServingTelemetry,
} from "./serving.ts";
import type { IndexDescriptor } from "./strategy.ts";

const db = {} as Database;
const BGE = QUERYABLE_INDEXES["bge-m3-5617a9f6"] as SemanticIndex;
const NOW = new Date("2026-11-14T10:00:00Z");
const HNSW_BGE: IndexDescriptor = {
  id: "product_text_embedding_d1024_hnsw_bge_m3_5617a9f6_v1",
  kind: "global_hnsw",
  modelVersion: "bge-m3-5617a9f6",
  indexVersion: "1",
  scope: { type: "global" },
  state: "ready",
};
const HNSW_JINA: IndexDescriptor = {
  id: "product_text_embedding_hnsw_jina_embeddings_v3_v1",
  kind: "global_hnsw",
  modelVersion: "jina-embeddings-v3",
  indexVersion: "1",
  scope: { type: "global" },
  state: "ready",
};

function item(id: number, title: string): RankedSearchItem {
  return {
    productId: id,
    publicId: `p${id}`,
    slug: `s${id}`,
    title,
    primaryImageUrl: null,
    minPrice: 1000,
    brandName: null,
    categoryPath: null,
    merchantTrustScore: 80,
    inStock: true,
    currentPercentile: null,
    listPriceInflated: false,
    offerCount: 1,
    score: 1,
    match: { tier: "exact", score: 1, stage: "exact", relaxed: [], missing: [] },
  };
}

const TEXT = [
  item(1, "Kablosuz Kulaklik Siyah"),
  item(2, "Kablosuz Kulaklik Beyaz"),
  item(3, "Bluetooth Kablosuz Kulaklik"),
];

function input(over: Partial<ServingInput<RankedSearchItem>> = {}): ServingInput<RankedSearchItem> {
  return {
    semanticText: "kablosuz kulaklik",
    queryText: "kablosuz kulaklik",
    filters: {},
    items: TEXT,
    mode: "results",
    page: 1,
    sort: "balanced",
    ...over,
  };
}

const vec = new Array<number>(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0));

function fakeEmbedder(result: "ok" | "null" = "ok"): QueryEmbedder & { calls: number } {
  const e = {
    modelVersion: "bge-m3-5617a9f6",
    calls: 0,
    async embedQuery() {
      e.calls += 1;
      return result === "ok" ? { vector: vec, cacheHit: false, latencyMs: 1 } : null;
    },
  };
  return e;
}

function deps(over: Partial<ServingDeps> = {}): ServingDeps & { logged: ServingTelemetry[] } {
  const logged: ServingTelemetry[] = [];
  return {
    env: { SEMANTIC_SEARCH_MODE: "on" },
    embedder: fakeEmbedder(),
    health: createProviderHealth(),
    resolveIndex: async () => ({ index: BGE, source: "db" }),
    loadInventory: async () => [HNSW_BGE],
    loadStat: async () => null,
    findGlobal: async () => [
      { productId: 2, title: "Kablosuz Kulaklik Beyaz", similarity: 0.62 },
      { productId: 9, title: "Gurultu Onleyici Kablosuz Kulaklik Kulak Ustu", similarity: 0.67 },
      { productId: 10, title: "Kablolu Kulaklik Mikrofonlu Oyuncu", similarity: 0.66 },
    ],
    findExact: async () => [],
    findSimilarities: async () =>
      new Map([
        [1, 0.58],
        [2, 0.62],
        [3, 0.57],
      ]),
    hydrate: async (_db, ids) =>
      ids.map((id) => ({
        ...item(id, `Urun ${id}`),
        match: {
          tier: "related" as const,
          score: 0,
          stage: "related" as const,
          relaxed: [],
          missing: [],
        },
      })),
    usedToday: async () => 0,
    loadLexicon: async () => [],
    now: () => NOW,
    log: (t) => logged.push(t),
    logged,
    ...over,
  };
}

beforeEach(() => resetSemanticServingCounters());

describe("BGE-M3 kaydi", () => {
  it("uzak servis + kosullu birlestirme + ayri sorgu adresi; Jina ayarlari degismedi", () => {
    expect(BGE).toMatchObject({
      provider: "remote_http",
      fusion: "conditional_hybrid",
      table: "product_text_embedding_d1024",
      dimensions: 1024,
    });
    expect(BGE.endpoint?.servedModel).toBe("BAAI/bge-m3");
    const jina = QUERYABLE_INDEXES["jina-embeddings-v3"] as SemanticIndex;
    expect(jina).toMatchObject({ provider: "jina", fusion: "rrf_gate", dimensions: 768 });
  });
});

describe("sunum", () => {
  it("hazir BGE indeksi + saglikli servis: metin sonuclari ayni sirada basta, anlamsal eklemeler arkada", async () => {
    const d = deps();
    const r = await applySemanticServing(db, input(), d);
    expect(r.telemetry).toMatchObject({
      outcome: "served",
      reason: "fused",
      strategy: "global_hnsw",
    });
    const ids = r.items.map((x) => x.productId);
    expect(ids.slice(0, 3)).toEqual([1, 2, 3]);
    expect(ids).toContain(9);
    // karsit ozellik (kablolu) sorguda "kablosuz" iken reddedilir
    expect(ids).not.toContain(10);
    expect(r.items.length - TEXT.length).toBeLessThanOrEqual(8);
  });

  it("Jina HNSW'si olan ama BGE indeksi olmayan envanter: BGE sorgulanmaz, servise gidilmez", async () => {
    const e = fakeEmbedder();
    const d = deps({ embedder: e, loadInventory: async () => [HNSW_JINA] });
    const r = await applySemanticServing(db, input(), d);
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.outcome).toBe("skipped");
    expect(r.telemetry.reason).toMatch(/^strategy_/);
    expect(e.calls).toBe(0);
  });

  it("yanlis surum (v2) ve hazir olmayan indeks: sorgulanmaz", async () => {
    for (const bad of [
      { ...HNSW_BGE, indexVersion: "2" },
      { ...HNSW_BGE, state: "building" as const },
      { ...HNSW_BGE, state: "invalid" as const },
    ]) {
      const e = fakeEmbedder();
      const r = await applySemanticServing(
        db,
        input(),
        deps({ embedder: e, loadInventory: async () => [bad] }),
      );
      expect(r.items).toBe(TEXT);
      expect(e.calls).toBe(0);
    }
  });

  it("servis vektor vermezse sonuc metin aramasinin AYNISI (ayni dizi)", async () => {
    const r = await applySemanticServing(db, input(), deps({ embedder: fakeEmbedder("null") }));
    expect(r.items).toBe(TEXT);
    expect(r.telemetry).toMatchObject({ outcome: "skipped", reason: "no_vector" });
  });

  it("sorgu servisi adresi yok: `no_endpoint`, servise gidilmez", async () => {
    const { embedder: _omit, ...rest } = deps();
    const r = await applySemanticServing(db, input(), {
      ...rest,
      env: { SEMANTIC_SEARCH_MODE: "on" },
    });
    expect(r.items).toBe(TEXT);
    expect(r.telemetry).toMatchObject({ outcome: "skipped", reason: "no_endpoint" });
  });

  it("anlamsal sorgu hatasi (SQL zaman asimi vb.): metin sonucu degismez", async () => {
    const r = await applySemanticServing(
      db,
      input(),
      deps({
        findGlobal: async () => {
          throw Object.assign(new Error("x"), { code: "57014" });
        },
      }),
    );
    expect(r.items).toBe(TEXT);
    expect(r.telemetry).toMatchObject({ outcome: "error", reason: "timeout" });
  });

  it("sozluk okunamazsa bos sozlukle devam eder (arama bozulmaz)", async () => {
    const r = await applySemanticServing(
      db,
      input(),
      deps({
        loadLexicon: async () => {
          throw new Error("db");
        },
      }),
    );
    expect(r.telemetry.outcome).toBe("served");
  });
});

describe("devre kesici: servis arizali/yanlis modelse tekrar tekrar denenmez", () => {
  it("art arda yanlis model yaniti -> `provider_unhealthy`; servise yeni istek gitmez", async () => {
    let calls = 0;
    const health = createProviderHealth();
    const wrong = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ model: "baska", data: [{ embedding: vec }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const embedder = createRemoteQueryEmbedder(
      { baseUrl: "http://embed-query:8080", servedModel: "BAAI/bge-m3" },
      "bge-m3-5617a9f6",
      1024,
      {
        fetch: wrong,
        cache: new Map(),
        onFailure: (f) => health.failure(f),
        onSuccess: () => health.success(),
      },
    );
    const d = () => deps({ embedder, health });
    for (let i = 0; i < 3; i++) {
      const r = await applySemanticServing(db, input({ semanticText: `sorgu ${i}` }), d());
      expect(r.telemetry.reason).toBe("no_vector");
      expect(r.items).toBe(TEXT);
    }
    expect(calls).toBe(3);
    const blocked = await applySemanticServing(db, input({ semanticText: "sorgu 9" }), d());
    expect(blocked.telemetry.reason).toBe("provider_unhealthy");
    expect(calls).toBe(3); // yeni istek GITMEDI
    expect(blocked.items).toBe(TEXT);
  });
});
