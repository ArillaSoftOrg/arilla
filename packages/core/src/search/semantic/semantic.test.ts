/**
 * Anlamsal arama gölge olcumu (karar 0178): ayarlar, fuzyon kapisi, sorgu embedding istemcisi ve
 * olcum akisi. Veritabani/ag yok; veritabanli akis `semantic-candidates.integration.test.ts`.
 */
import type { Database } from "@arilla/db";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SEMANTIC_INDEX } from "./active-index.ts";
import {
  DEFAULT_SEMANTIC_MODEL,
  semanticModelVersion,
  semanticSearchMode,
  shadowDailyCap,
  shadowSamplePercent,
} from "./config.ts";
import { fuseResults, gateSemantic } from "./fusion.ts";
import { createJinaQueryEmbedder, type QueryEmbedder } from "./query-embedder.ts";
import type { SemanticCandidate, SemanticCandidateRequest } from "./semantic-candidates.ts";
import {
  compareTopN,
  measureSemanticShadow,
  type ShadowDeps,
  type ShadowInput,
  type ShadowMetrics,
  scheduleSemanticShadow,
} from "./shadow.ts";

const db = {} as Database;
const item = (id: number, title = `urun ${id}`) => ({ productId: id, title });
const sem = (id: number, similarity: number, title = `urun ${id}`): SemanticCandidate => ({
  productId: id,
  title,
  similarity,
});
const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 768);

describe("ayarlar", () => {
  it("mod yalniz tam olarak shadow iken acilir", () => {
    expect(semanticSearchMode({})).toBe("off");
    expect(semanticSearchMode({ SEMANTIC_SEARCH_MODE: " Shadow " })).toBe("shadow");
    expect(semanticSearchMode({ SEMANTIC_SEARCH_MODE: "on" })).toBe("off");
    expect(semanticSearchMode({ SEMANTIC_SEARCH_MODE: "true" })).toBe("off");
  });

  it("model adi dar desene uymazsa varsayilana duser (SQL'e metin olarak girer)", () => {
    expect(semanticModelVersion({})).toBe(DEFAULT_SEMANTIC_MODEL);
    expect(semanticModelVersion({ SEMANTIC_EMBEDDING_MODEL: "jina-embeddings-v4" })).toBe(
      "jina-embeddings-v4",
    );
    expect(semanticModelVersion({ SEMANTIC_EMBEDDING_MODEL: "x'; DROP TABLE product;--" })).toBe(
      DEFAULT_SEMANTIC_MODEL,
    );
  });

  it("tavan ve orneklem yalniz duz tamsayi kabul eder", () => {
    expect(shadowDailyCap({})).toBe(2000);
    expect(shadowDailyCap({ SEMANTIC_SHADOW_DAILY_CAP: "50" })).toBe(50);
    expect(shadowDailyCap({ SEMANTIC_SHADOW_DAILY_CAP: "-5" })).toBe(2000);
    expect(shadowSamplePercent({ SEMANTIC_SHADOW_SAMPLE_PERCENT: "250" })).toBe(100);
    expect(shadowSamplePercent({ SEMANTIC_SHADOW_SAMPLE_PERCENT: "0" })).toBe(0);
  });
});

describe("fuzyon (karar 0170 kapisi)", () => {
  it("metin sonuclari asla dusmez; ortak urun ustte", () => {
    const fused = fuseResults([item(1), item(2), item(3)], [sem(3, 0.9), sem(9, 0.85)], {
      gate: { minSimilarity: 0.4, maxGapFromBest: 0.2, maxSemanticOnly: 5 },
    });
    expect(fused.map((entry) => entry.item.productId)).toEqual([3, 1, 2, 9]);
    expect(fused.find((entry) => entry.item.productId === 9)?.source).toBe("semantic");
  });

  it("esik alti ve en iyiden cok dusuk adaylar girmez; anlamsal-yalniz tavanlanir", () => {
    const gate = { minSimilarity: 0.5, maxGapFromBest: 0.1, maxSemanticOnly: 1 };
    expect(gateSemantic([sem(1, 0.45)], new Set(), gate)).toEqual([]);
    const kept = gateSemantic([sem(1, 0.8), sem(2, 0.75), sem(3, 0.6)], new Set([2]), gate);
    expect(kept.map((candidate) => candidate.productId)).toEqual([1, 2]);
  });

  it("vektoru olup benzemeyen metin sonucu anlamsal eslesmenin altina iner, vektorsuz cezalanmaz", () => {
    const gate = { minSimilarity: 0.4, maxGapFromBest: 0.2, maxSemanticOnly: 5 };
    const demoted = fuseResults([item(1), item(2)], [sem(9, 0.8)], {
      gate,
      textSimilarity: new Map([[1, 0.1]]),
    });
    expect(demoted.map((entry) => entry.item.productId)).toEqual([9, 2, 1]);
    const kept = fuseResults([item(1)], [sem(9, 0.8)], { gate, textSimilarity: new Map() });
    expect(kept.map((entry) => entry.item.productId)).toEqual([1, 9]);
  });
});

describe("sorgu embedding istemcisi", () => {
  const ok = () =>
    new Response(JSON.stringify({ data: [{ embedding: VECTOR }], usage: { total_tokens: 7 } }), {
      status: 200,
    });

  it("v3 sorgu gorevi; ayni sorgu ikinci kez API'ye gitmez; kullanim bildirilir", async () => {
    const fetchMock = vi.fn(async () => ok());
    const usage = vi.fn();
    const embedder = createJinaQueryEmbedder("k", "jina-embeddings-v3", {
      fetch: fetchMock as unknown as typeof fetch,
      onUsage: usage,
      cache: new Map(),
    });
    const first = await embedder.embedQuery("Kablosuz  Fare ");
    const second = await embedder.embedQuery("kablosuz fare");
    expect(first).toMatchObject({ vector: VECTOR, cacheHit: false });
    expect(second).toMatchObject({ vector: VECTOR, cacheHit: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tokens: 7, cacheHit: false }),
    );
    expect(usage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tokens: 0, cacheHit: true }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    );
    expect(body).toMatchObject({
      model: "jina-embeddings-v3",
      task: "retrieval.query",
      dimensions: 768,
      normalized: true,
      input: ["Kablosuz Fare"],
    });
  });

  it("HTTP hatasi, gecersiz boyut/deger, ag hatasi ve bos sorgu null doner (firlatmaz)", async () => {
    const make = (impl: () => Promise<Response>) =>
      createJinaQueryEmbedder("k", "jina-embeddings-v3", {
        fetch: impl as unknown as typeof fetch,
        cache: new Map(),
      });
    expect(await make(async () => new Response("x", { status: 503 })).embedQuery("a b")).toBeNull();
    const short = JSON.stringify({ data: [{ embedding: [1, 2] }] });
    expect(
      await make(async () => new Response(short, { status: 200 })).embedQuery("a b"),
    ).toBeNull();
    const nan = JSON.stringify({ data: [{ embedding: VECTOR.map(() => "x") }] });
    expect(await make(async () => new Response(nan, { status: 200 })).embedQuery("a b")).toBeNull();
    expect(
      await make(async () => {
        throw new Error("ag");
      }).embedQuery("a b"),
    ).toBeNull();
    expect(await make(async () => ok()).embedQuery("   ")).toBeNull();
  });
});

describe("ilk N karsilastirmasi", () => {
  it("kapidan gecen anlamsal-yalniz urunler ilk N'e girer, metin sirasi korunur", () => {
    const text = [item(1), item(2), item(3)];
    const result = compareTopN(text, [sem(9, 0.8), sem(1, 0.79)], "kablosuz fare", new Map(), 3);
    expect(result).toEqual({ gatePassed: 2, semanticOnly: 1, overlapTopN: 2, newInTopN: 1 });
  });

  it("aksesuar istemeyen sorguda aksesuar adayi alinmaz", () => {
    const accessory = sem(9, 0.9, "silicone case cover for apple watch series 9");
    const result = compareTopN([item(1)], [accessory], "akilli saat", new Map(), 6);
    expect(result.semanticOnly).toBe(0);
    expect(result.newInTopN).toBe(0);
  });

  it("metin sonucu yoksa anlamsal adaylar ilk N'i doldurur", () => {
    const result = compareTopN([], [sem(5, 0.7), sem(6, 0.68)], "otomobil", new Map(), 6);
    expect(result).toEqual({ gatePassed: 2, semanticOnly: 2, overlapTopN: 0, newInTopN: 2 });
  });
});

describe("olcum akisi", () => {
  const input: ShadowInput = {
    semanticText: "kablosuz fare",
    queryText: "kablosuz fare",
    filters: {},
    textItems: [item(1), item(2)],
    topN: 6,
  };
  const env = { SEMANTIC_SEARCH_MODE: "shadow", JINA_API_KEY: "k" };

  function harness(overrides: Partial<ShadowDeps> = {}) {
    const recorded: ShadowMetrics[] = [];
    const embedQuery = vi.fn(async () => ({ vector: VECTOR, cacheHit: false, latencyMs: 3 }));
    const embedder: QueryEmbedder = { modelVersion: "jina-embeddings-v3", embedQuery };
    const deps: ShadowDeps = {
      env,
      embedder,
      usedToday: async () => 0,
      resolveIndex: async () => ({ index: DEFAULT_SEMANTIC_INDEX, source: "db" }),
      findCandidates: async () => [sem(9, 0.8), sem(1, 0.78)],
      findSimilarities: async () => new Map([[1, 0.78]]),
      record: async (_db, metrics) => {
        recorded.push(metrics);
      },
      random: () => 0,
      ...overrides,
    };
    return { recorded, embedQuery, deps };
  }

  it("olcer ve yalniz sayisal alanlari yazar", async () => {
    const { recorded, deps } = harness();
    const metrics = await measureSemanticShadow(db, input, deps);
    expect(metrics).toMatchObject({
      outcome: "measured",
      modelVersion: "jina-embeddings-v3",
      textCount: 2,
      topN: 6,
      textWithVector: 1,
      candidateCount: 2,
      bestSimilarity: 0.8,
      semanticOnly: 1,
      newInTopN: 1,
      overlapTopN: 2,
      cacheHit: false,
    });
    expect(recorded).toHaveLength(1);
    const serialized = JSON.stringify(recorded[0]);
    expect(serialized).not.toContain("kablosuz");
  });

  it("kisisel veri iceren sorgu saglayiciya gitmez", async () => {
    const { recorded, embedQuery, deps } = harness();
    const metrics = await measureSemanticShadow(
      db,
      { ...input, semanticText: "ali veli 05321234567 kılıf" },
      deps,
    );
    expect(embedQuery).not.toHaveBeenCalled();
    expect(metrics?.outcome).toBe("ineligible");
    expect(recorded[0]?.reason).toMatch(/^[a-z_]+$/);
  });

  it("aktif indeks TS'nin sorgulayamadigi bir modelse saglayici cagrilmaz (karar 0181)", async () => {
    const { recorded, embedQuery, deps } = harness({
      resolveIndex: async () => ({
        index: null,
        reason: "unsupported_model",
        modelVersion: "e5-small-int8-0bcc8ca76950",
      }),
    });
    expect(await measureSemanticShadow(db, input, deps)).toMatchObject({
      outcome: "no_vector",
      reason: "unsupported_model",
      modelVersion: "e5-small-int8-0bcc8ca76950",
    });
    expect(embedQuery).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
  });

  it("aday sorgusu aktif indeksi alir", async () => {
    const findCandidates = vi.fn(async (_db: Database, _request: SemanticCandidateRequest) => [
      sem(9, 0.8),
    ]);
    const { deps } = harness({ findCandidates });
    await measureSemanticShadow(db, input, deps);
    expect(findCandidates.mock.calls[0]?.[1]).toMatchObject({ index: DEFAULT_SEMANTIC_INDEX });
  });

  it("gunluk tavan doluysa cagri yapilmaz", async () => {
    const { embedQuery, deps } = harness({ usedToday: async () => 2000 });
    expect((await measureSemanticShadow(db, input, deps))?.outcome).toBe("capped");
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it("anahtar yoksa ve saglayici vektor donmezse no_vector", async () => {
    const noKey = harness({ embedder: null });
    expect(await measureSemanticShadow(db, input, noKey.deps)).toMatchObject({
      outcome: "no_vector",
      reason: "no_api_key",
    });
    const failing = harness();
    failing.embedQuery.mockResolvedValueOnce(null as never);
    expect(await measureSemanticShadow(db, input, failing.deps)).toMatchObject({
      outcome: "no_vector",
      reason: "provider",
    });
  });

  it("aday sorgusu hatasi yutulur ve sinif adiyla kaydedilir", async () => {
    const timeout = Object.assign(new Error("canceling statement"), { cause: { code: "57014" } });
    const { recorded, deps } = harness({
      findCandidates: async () => {
        throw timeout;
      },
    });
    expect(await measureSemanticShadow(db, input, deps)).toMatchObject({
      outcome: "error",
      reason: "timeout",
    });
    expect(recorded).toHaveLength(1);
  });

  it("kayit yazilamasa da firlatmaz; orneklem disi hic olcmez", async () => {
    const broken = harness({
      record: async () => {
        throw new Error("db");
      },
    });
    await expect(measureSemanticShadow(db, input, broken.deps)).resolves.toMatchObject({
      outcome: "measured",
    });
    const sampled = harness({
      env: { ...env, SEMANTIC_SHADOW_SAMPLE_PERCENT: "0" },
    });
    expect(await measureSemanticShadow(db, input, sampled.deps)).toBeNull();
    expect(sampled.recorded).toHaveLength(0);
  });

  it("mod kapaliyken zamanlanmaz; ayni anda en fazla iki olcum", async () => {
    const off = harness({ env: {} });
    expect(scheduleSemanticShadow(db, input, off.deps)).toBeNull();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = harness({
      findCandidates: async () => {
        await gate;
        return [];
      },
    });
    const first = scheduleSemanticShadow(db, input, slow.deps);
    const second = scheduleSemanticShadow(db, input, slow.deps);
    const third = scheduleSemanticShadow(db, input, slow.deps);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    release();
    await Promise.all([first, second]);
    expect(scheduleSemanticShadow(db, input, slow.deps)).not.toBeNull();
  });
});
