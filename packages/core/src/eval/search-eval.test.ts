import { describe, expect, it } from "vitest";
import {
  catalogFingerprint,
  comparabilityIssues,
  compareRunIds,
  compareSearch,
  parseSearchEvalEngine,
  parseSearchEvalFile,
  parseSearchEvalScope,
  SEARCH_EVAL_FORMAT,
  type SearchEvalMeta,
  type SearchEvalRow,
  summarizeSearch,
} from "./search-eval.ts";

const row = (over: Partial<SearchEvalRow>): SearchEvalRow => ({
  q: "x",
  absent: false,
  returned: 10,
  relevance: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  relevantInCatalog: 5,
  zeroResultCorrect: null,
  usedFallback: false,
  ...over,
});

describe("summarizeSearch", () => {
  it("tam isabette P@5 ve NDCG@10 = 1", () => {
    const s = summarizeSearch([row({})]);
    expect(s.precisionAt5).toBe(1);
    expect(s.ndcgAt10).toBeCloseTo(1);
    expect(s.zeroResultRate).toBe(0);
  });

  it("karsiligi olmayan sorguda bos donmek dogrudur, P@5'i etkilemez", () => {
    const s = summarizeSearch([
      row({}),
      row({
        absent: true,
        returned: 0,
        relevance: [],
        relevantInCatalog: 0,
        zeroResultCorrect: true,
      }),
    ]);
    expect(s.precisionAt5).toBe(1);
    expect(s.absentCorrectRate).toBe(1);
    expect(s.zeroResultRate).toBe(0.5);
  });

  it("hic ilgili donmeyen sorgu missRate'e girer", () => {
    const s = summarizeSearch([row({ relevance: [0, 0, 0, 0, 0] }), row({})]);
    expect(s.missRate).toBe(0.5);
  });
});

describe("compareSearch", () => {
  it("P@5 dususte regresyon bildirir", () => {
    const good = summarizeSearch([row({})]);
    const bad = summarizeSearch([row({ relevance: [0, 0, 1, 0, 0] })]);
    const changes = compareSearch(good, bad);
    expect(changes.find((c) => c.metric === "precisionAt5")?.regressed).toBe(true);
  });
});

const meta = (over: Partial<SearchEvalMeta> = {}): SearchEvalMeta => ({
  format: SEARCH_EVAL_FORMAT,
  createdAt: "2026-11-04T00:00:00.000Z",
  codeRef: "abc",
  engine: "legacy",
  scope: { kind: "bootstrap" },
  catalog: {
    merchantIds: [1, 2],
    products: 10,
    activeOffers: 12,
    maxProductId: 99,
    maxOfferId: 120,
    fingerprint: "f1",
  },
  dataset: { name: "bootstrap-queries", queries: 1, sha256: "d1" },
  ...over,
});

describe("parseSearchEvalScope / parseSearchEvalEngine", () => {
  it("varsayilanlar eski davranistir", () => {
    expect(parseSearchEvalScope(undefined)).toEqual({ kind: "bootstrap" });
    expect(parseSearchEvalEngine(undefined)).toBe("legacy");
  });

  it("magaza listesini tekillestirip siralar, gecersiz degeri reddeder", () => {
    expect(parseSearchEvalScope("all")).toEqual({ kind: "all_active" });
    expect(parseSearchEvalScope("merchants:7,3,7")).toEqual({
      kind: "merchants",
      merchantIds: [3, 7],
    });
    expect(parseSearchEvalScope("merchants:")).toBeNull();
    expect(parseSearchEvalScope("merchants:a")).toBeNull();
    expect(parseSearchEvalEngine("fallback")).toBe("fallback");
    expect(parseSearchEvalEngine("llm")).toBeNull();
  });
});

describe("catalogFingerprint", () => {
  const base = {
    merchantIds: [2, 1],
    products: 10,
    activeOffers: 12,
    maxProductId: 99,
    maxOfferId: 120,
  };
  const hash = (text: string) => `h:${text}`;

  it("magaza sirasindan bagimsiz, sayilara duyarli", () => {
    expect(catalogFingerprint(base, hash)).toBe(
      catalogFingerprint({ ...base, merchantIds: [1, 2] }, hash),
    );
    expect(catalogFingerprint(base, hash)).not.toBe(
      catalogFingerprint({ ...base, activeOffers: 13 }, hash),
    );
  });
});

describe("parseSearchEvalFile", () => {
  it("v1 satir dizisini metadata'siz kabul eder", () => {
    const run = parseSearchEvalFile([row({})]);
    expect(run.meta).toBeNull();
    expect(run.rows).toHaveLength(1);
  });

  it("v2 zarfini kabul eder, taninmayan bicimi reddeder", () => {
    expect(parseSearchEvalFile({ meta: meta(), rows: [row({})] }).meta?.engine).toBe("legacy");
    expect(() => parseSearchEvalFile({ rows: [] })).toThrow();
  });
});

describe("comparabilityIssues", () => {
  it("ayni katalog, kapsam ve sette sorun yok", () => {
    expect(comparabilityIssues(meta(), meta({ codeRef: "def", engine: "fallback" }))).toEqual([]);
  });

  it("parmak izi, set ve kapsam farkini ve v1'i bildirir", () => {
    const other = meta({
      catalog: { ...meta().catalog, fingerprint: "f2" },
      dataset: { name: "bootstrap-queries", queries: 1, sha256: "d2" },
      scope: { kind: "all_active" },
    });
    expect(comparabilityIssues(meta(), other)).toHaveLength(3);
    expect(comparabilityIssues(null, meta())).toHaveLength(1);
  });
});

describe("compareRunIds", () => {
  it("ayni ilk 10 listesi birebir sayilir", () => {
    const r = row({ q: "a", topIds: [1, 2, 3], stage: "primary" });
    const result = compareRunIds([r], [r]);
    expect(result).toMatchObject({ compared: 1, identical: 1, meanOverlapAt10: 1, unmatched: [] });
  });

  it("sira degisikligi birebir degildir ama ortusme tamdir", () => {
    const result = compareRunIds(
      [row({ q: "a", topIds: [1, 2, 3] })],
      [row({ q: "a", topIds: [3, 2, 1] })],
    );
    expect(result.identical).toBe(0);
    expect(result.diffs[0]).toMatchObject({ overlap: 3, added: [], removed: [] });
    expect(result.meanOverlapAt10).toBe(1);
  });

  it("eklenen/cikan urunleri, asama degisimini ve eslesmeyen sorgulari raporlar", () => {
    const result = compareRunIds(
      [row({ q: "a", topIds: [1, 2], stage: "exact" }), row({ q: "b", topIds: [5] })],
      [row({ q: "a", topIds: [2, 9], stage: "alias" }), row({ q: "c", topIds: [5] })],
    );
    expect(result.diffs[0]).toMatchObject({
      overlap: 1,
      added: [9],
      removed: [1],
      baseStage: "exact",
      currentStage: "alias",
    });
    expect(result.meanOverlapAt10).toBe(0.5);
    expect(result.unmatched).toEqual(["b", "c"]);
  });

  it("kimligi olmayan (v1) satir karsilastirilmaz; iki bos liste ayni sayilir", () => {
    const result = compareRunIds(
      [row({ q: "a" }), row({ q: "z", topIds: [] })],
      [row({ q: "a", topIds: [1] }), row({ q: "z", topIds: [] })],
    );
    expect(result).toMatchObject({
      compared: 1,
      identical: 1,
      meanOverlapAt10: 1,
      unmatched: ["a"],
    });
  });
});
