/**
 * Anlamsal sunum (karar 0190): her kapinin ayri denetimi, hata/kapali durumda metin sonucunun
 * BIREBIR korunmasi, strateji secimi ve fuzyon. Veritabani ve ag sahte; SQL'in kendisi
 * `serving.integration.test.ts`te gercek PostgreSQL ile.
 */
import type { Database } from "@arilla/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RankedSearchItem } from "../fallback/types.ts";
import type { QueryFilters } from "../types.ts";
import type { SemanticIndex } from "./active-index.ts";
import { createProviderHealth } from "./provider-health.ts";
import type { QueryEmbedder } from "./query-embedder.ts";
import { SemanticPoolOverflowError } from "./semantic-candidates.ts";
import {
  applySemanticServing,
  resetSemanticServingCounters,
  type ServingDeps,
  type ServingInput,
  type ServingTelemetry,
  semanticServingCounters,
} from "./serving.ts";
import type { CategoryStat, IndexDescriptor } from "./strategy.ts";

const db = {} as Database;
const INDEX: SemanticIndex = {
  modelVersion: "jina-embeddings-v3",
  table: "product_text_embedding",
  dimensions: 768,
  queryTask: "retrieval.query",
};
const HNSW: IndexDescriptor = {
  id: "product_text_embedding_hnsw_jina_embeddings_v3_v1",
  kind: "global_hnsw",
  modelVersion: "jina-embeddings-v3",
  indexVersion: "1",
  scope: { type: "global" },
  state: "ready",
};
const BTREE: IndexDescriptor = {
  id: "product_category_idx",
  kind: "btree_category",
  modelVersion: null,
  indexVersion: null,
  scope: { type: "global" },
  state: "ready",
};
const NOW = new Date("2026-11-13T10:00:00Z");

function item(id: number, title = `Urun ${id}`): RankedSearchItem {
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
  item(1, "Kosu ayakkabisi 1"),
  item(2, "Kosu ayakkabisi 2"),
  item(3, "Kosu ayakkabisi 3"),
];

function input(over: Partial<ServingInput<RankedSearchItem>> = {}): ServingInput<RankedSearchItem> {
  return {
    semanticText: "kosu ayakkabisi",
    queryText: "kosu ayakkabisi",
    filters: {},
    items: TEXT,
    mode: "results",
    page: 1,
    sort: "balanced",
    ...over,
  };
}

const vector = new Array<number>(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));

function embedder(result: "ok" | "null" = "ok"): QueryEmbedder & { calls: number } {
  const e = {
    modelVersion: "jina-embeddings-v3",
    calls: 0,
    async embedQuery() {
      e.calls += 1;
      return result === "ok" ? { vector, cacheHit: false, latencyMs: 1 } : null;
    },
  };
  return e;
}

function deps(over: Partial<ServingDeps> = {}): ServingDeps & { logged: ServingTelemetry[] } {
  const logged: ServingTelemetry[] = [];
  return {
    env: { SEMANTIC_SEARCH_MODE: "on", JINA_API_KEY: "x" },
    embedder: embedder(),
    health: createProviderHealth(),
    resolveIndex: async () => ({ index: INDEX, source: "db" }),
    loadInventory: async () => [HNSW, BTREE],
    loadStat: async () => null,
    findGlobal: async () => [
      { productId: 2, title: "Kosu ayakkabisi 2", similarity: 0.8 },
      { productId: 9, title: "Kosu ayakkabisi 9", similarity: 0.79 },
    ],
    findExact: async () => [],
    findSimilarities: async () => new Map([[2, 0.8]]),
    hydrate: async (_db, ids) =>
      ids.map((id) => ({ ...item(id), match: { ...item(id).match, tier: "related" as const } })),
    usedToday: async () => 0,
    now: () => NOW,
    log: (t) => logged.push(t),
    logged,
    ...over,
  };
}

beforeEach(() => resetSemanticServingCounters());

describe("kapali mod: hicbir I/O yok, sonuc ayni dizi", () => {
  it.each([{}, { SEMANTIC_SEARCH_MODE: "shadow" }, { SEMANTIC_SEARCH_MODE: "true" }])(
    "%j",
    async (env) => {
      const d = deps({ env, resolveIndex: vi.fn(), loadInventory: vi.fn(), embedder: embedder() });
      const r = await applySemanticServing(db, input(), d);
      expect(r.items).toBe(TEXT);
      expect(r.telemetry.outcome).toBe("disabled");
      expect(d.resolveIndex).not.toHaveBeenCalled();
      expect(d.loadInventory).not.toHaveBeenCalled();
      expect(d.logged).toEqual([]);
    },
  );
});

describe("acik mod: kapilar", () => {
  it("hazir HNSW + saglikli saglayici -> global_hnsw ile fuzyon, metin sonucu korunur", async () => {
    const r = await applySemanticServing(db, input(), deps());
    expect(r.telemetry).toMatchObject({
      outcome: "served",
      reason: "fused",
      strategy: "global_hnsw",
    });
    const ids = r.items.map((i) => i.productId);
    expect(ids).toEqual(expect.arrayContaining([1, 2, 3, 9]));
    expect(ids).toHaveLength(4);
    // Metin sonucunun hepsi korunur; yalniz-anlamsal urun sona yakin, eklenen sayisi telemetride.
    expect(r.telemetry.added).toBe(1);
  });

  it("HNSW yok (bugunku uretim) -> anlamsal HIC calismaz, saglayiciya gidilmez", async () => {
    const e = embedder();
    const r = await applySemanticServing(
      db,
      input(),
      deps({ loadInventory: async () => [BTREE], embedder: e }),
    );
    expect(r.items).toBe(TEXT);
    expect(r.telemetry).toMatchObject({ outcome: "skipped", reason: "strategy_legacy_postfilter" });
    expect(e.calls).toBe(0);
  });

  it.each([
    ["building", { ...HNSW, state: "building" as const }],
    ["invalid", { ...HNSW, state: "invalid" as const }],
    ["baska model", { ...HNSW, modelVersion: "bge-m3" }],
    ["baska surum", { ...HNSW, indexVersion: "2" }],
    ["surumsuz", { ...HNSW, indexVersion: null }],
  ])("hazir olmayan/uyumsuz indeks (%s) -> metin aramasi", async (_name, index) => {
    const e = embedder();
    const r = await applySemanticServing(
      db,
      input(),
      deps({ loadInventory: async () => [index, BTREE], embedder: e }),
    );
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.outcome).toBe("skipped");
    expect(e.calls).toBe(0);
  });

  it("envanter okunamadi -> metin aramasi", async () => {
    const r = await applySemanticServing(db, input(), deps({ loadInventory: async () => null }));
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.reason).toBe("strategy_legacy_postfilter");
  });

  it("aktif indeks yok / TS'de sorgulanamayan model -> metin aramasi", async () => {
    for (const reason of ["no_active_index", "unsupported_model"] as const) {
      const r = await applySemanticServing(
        db,
        input(),
        deps({ resolveIndex: async () => ({ index: null, reason, modelVersion: "bge-m3" }) }),
      );
      expect(r.items).toBe(TEXT);
      expect(r.telemetry.reason).toBe(reason);
    }
  });

  it("anahtar yok -> no_api_key; anahtar tanimli ama saglayici 403 (devre acik) -> provider_unhealthy", async () => {
    const r1 = await applySemanticServing(db, input(), deps({ embedder: null }));
    expect(r1.telemetry.reason).toBe("no_api_key");
    const health = createProviderHealth();
    health.failure("quota");
    const e = embedder();
    const r2 = await applySemanticServing(db, input(), deps({ health, embedder: e }));
    expect(r2.items).toBe(TEXT);
    expect(r2.telemetry.reason).toBe("provider_unhealthy");
    expect(e.calls).toBe(0);
  });

  it("sorgu vektoru alinamadi (Jina 403 -> null) -> metin aramasi", async () => {
    const r = await applySemanticServing(db, input(), deps({ embedder: embedder("null") }));
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.reason).toBe("no_vector");
  });

  it("gunluk tavan -> ucretli cagri yok", async () => {
    const e = embedder();
    const r = await applySemanticServing(
      db,
      input(),
      deps({ usedToday: async () => 999_999, embedder: e }),
    );
    expect(r.telemetry.reason).toBe("capped");
    expect(e.calls).toBe(0);
  });

  it.each([
    ["ikinci sayfa", { page: 2 }, "not_first_page"],
    ["fiyat sekmesi", { sort: "best_deal" as const }, "sort_not_balanced"],
    ["metin sonucu bos", { mode: "empty" as const }, "lexical_empty"],
    ["bos metin", { semanticText: "  " }, "empty_text"],
    ["kisisel veri", { semanticText: "05321234567 numarali kisi" }, "ineligible"],
  ])("%s -> %s", async (_name, over, reason) => {
    const e = embedder();
    const r = await applySemanticServing(db, input(over), deps({ embedder: e }));
    expect(r.telemetry.reason).toBe(reason);
    expect(e.calls).toBe(0);
  });

  it("SQL hatasi (zaman asimi dahil) -> metin aramasi + yapisal hata", async () => {
    const timeout = Object.assign(new Error("canceling statement"), { code: "57014" });
    const r = await applySemanticServing(
      db,
      input(),
      deps({
        findGlobal: async () => {
          throw timeout;
        },
      }),
    );
    expect(r.items).toBe(TEXT);
    expect(r.telemetry).toMatchObject({
      outcome: "error",
      reason: "timeout",
      strategy: "global_hnsw",
    });
    expect(semanticServingCounters()["error:timeout"]).toBe(1);
  });

  it("kart hidrasyonu hatasi -> metin aramasi", async () => {
    const r = await applySemanticServing(
      db,
      input(),
      deps({
        hydrate: async () => {
          throw new TypeError("x");
        },
      }),
    );
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.reason).toBe("typeerror");
  });

  it("gunluk satiri sorgu metni ve urun kimligi tasimaz", async () => {
    const d = deps();
    await applySemanticServing(db, input({ semanticText: "gizli sorgu metni" }), d);
    const line = JSON.stringify(d.logged);
    expect(line).not.toContain("gizli");
    expect(line).not.toContain("Kosu");
    expect(Object.keys(d.logged[0] ?? {}).sort()).toEqual(
      [
        "added",
        "candidateCount",
        "categoryMode",
        "embedMs",
        "knnMs",
        "outcome",
        "reason",
        "strategy",
      ].sort(),
    );
  });
});

describe("kategori kaynagi -> strateji", () => {
  const stat = (rows: number): CategoryStat => ({ path: "moda/ayakkabi", rows, computedAt: NOW });
  const explicit: QueryFilters = { category_path: "moda/ayakkabi", category_source: "explicit_ui" };

  it("acik kategori, kucuk -> exact_btree (kategori parametresiyle)", async () => {
    const findExact = vi.fn(async () => [
      { productId: 7, title: "Kosu ayakkabisi 7", similarity: 0.9 },
    ]);
    const findGlobal = vi.fn(async () => []);
    const r = await applySemanticServing(
      db,
      input({ filters: explicit }),
      deps({ loadStat: async () => stat(150), findExact, findGlobal }),
    );
    expect(r.telemetry).toMatchObject({ strategy: "exact_btree", categoryMode: "hard" });
    expect(findGlobal).not.toHaveBeenCalled();
    expect(findExact).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ categoryPath: "moda/ayakkabi", maxRows: 2000 }),
    );
  });

  it("acik kategori, buyuk ve kismi indeks yok -> global+filtre SECILMEZ, metin aramasi", async () => {
    const e = embedder();
    const r = await applySemanticServing(
      db,
      input({ filters: explicit }),
      deps({ loadStat: async () => stat(50_000), embedder: e }),
    );
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.reason).toBe("strategy_legacy_postfilter");
    expect(e.calls).toBe(0);
  });

  it("acik kategori, istatistik yok -> metin aramasi", async () => {
    const r = await applySemanticServing(db, input({ filters: explicit }), deps());
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.categoryMode).toBe("hard");
  });

  it("kategori havuzu tasti (istatistik bayat) -> metin aramasi, eksik sonuc verilmez", async () => {
    const r = await applySemanticServing(
      db,
      input({ filters: explicit }),
      deps({
        loadStat: async () => stat(10),
        findExact: async () => {
          throw new SemanticPoolOverflowError();
        },
      }),
    );
    expect(r.items).toBe(TEXT);
    expect(r.telemetry.reason).toBe("semanticpooloverflowerror");
  });

  it("tahmin edilen kategori (ipucu) -> kesin filtre degil, global_hnsw, istatistik okunmaz", async () => {
    const loadStat = vi.fn(async () => stat(10));
    const r = await applySemanticServing(
      db,
      input({ filters: { category_hint: "moda/ayakkabi" } }),
      deps({ loadStat }),
    );
    expect(r.telemetry).toMatchObject({ strategy: "global_hnsw", categoryMode: "soft" });
    expect(loadStat).not.toHaveBeenCalled();
  });

  it("kaynagi bilinmeyen eski kategori acik sayilmaz (soft)", async () => {
    const r = await applySemanticServing(
      db,
      input({ filters: { category_path: "moda/ayakkabi" } }),
      deps(),
    );
    expect(r.telemetry.categoryMode).toBe("soft");
  });
});

describe("fuzyon: metin sonucu hic dusmez", () => {
  it("tur uyusmazligi olan metin sonucu bile korunur (sona)", async () => {
    const items = [item(1, "Telefon kilifi"), item(2, "Kosu ayakkabisi 2")];
    const r = await applySemanticServing(
      db,
      input({ items, queryText: "kosu ayakkabisi" }),
      deps({
        findSimilarities: async () =>
          new Map([
            [1, 0.05],
            [2, 0.8],
          ]),
      }),
    );
    const ids = r.items.map((i) => i.productId);
    expect(ids).toEqual(expect.arrayContaining([1, 2]));
  });

  it("en fazla 8 yalniz-anlamsal urun eklenir", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      productId: 100 + i,
      title: `Kosu ayakkabisi ${100 + i}`,
      similarity: 0.8 - i * 0.001,
    }));
    const r = await applySemanticServing(db, input(), deps({ findGlobal: async () => many }));
    expect(r.telemetry.added).toBe(8);
    expect(r.items).toHaveLength(TEXT.length + 8);
  });

  it("hidrasyonda suzgeci gecmeyen (ornek fiyat) aday eklenmez", async () => {
    const r = await applySemanticServing(db, input(), deps({ hydrate: async () => [] }));
    expect(r.items.map((i) => i.productId).sort()).toEqual([1, 2, 3]);
    expect(r.telemetry.reason).toBe("no_new_candidates");
  });
});
