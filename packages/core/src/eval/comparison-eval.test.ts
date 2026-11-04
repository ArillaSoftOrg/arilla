import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import { parseQueryText } from "../search/parse-query.ts";
import type { QueryObject } from "../search/types.ts";
import {
  type ComparisonCase,
  type ComparisonDataset,
  scoreComparisonCase,
  summarizeComparison,
} from "./comparison-eval.ts";
import dataset from "./datasets/comparison-queries.dev.json" with { type: "json" };
import { brandEntries } from "./intent-v2-eval.ts";

const DEV = dataset as unknown as ComparisonDataset;

const parsed = (over: Partial<QueryObject> = {}): QueryObject => ({
  intent: "browse",
  anchor: null,
  text: "",
  filters: {},
  style_tags: [],
  sort: "balanced",
  unparsed: "",
  confidence: 1,
  ...over,
});

const testCase = (over: Partial<ComparisonCase["gold"]>, id = "t1"): ComparisonCase => ({
  id,
  cat: over.relation === null ? "control" : (over.relation ?? "cheaper"),
  typo: false,
  q: "",
  gold: {
    relation: "cheaper",
    anchor: { kind: "product", text: "dyson v15" },
    anchor_brand: "dyson",
    product_type: null,
    brand_include: [],
    exclude_brands: [],
    ...over,
  },
});

describe("scoreComparisonCase", () => {
  it("referans markasinin zorunlu filtreye donusmesini ve sizan isaretleri yakalar", () => {
    const r = scoreComparisonCase(
      testCase({}),
      parsed({ filters: { brand_include: ["dyson"] }, text_slots: [["v15"], ["daha"], ["ucuz"]] }),
    );
    expect(r.anchorBrandAsFilter).toBe(true);
    expect(r.markersLeaked).toEqual(["daha", "ucuz"]);
    expect(r.relationRecognized).toBe(false);
  });

  it("dogru davranis: referans filtre degil, isaret yok, iliski taninmis", () => {
    const r = scoreComparisonCase(
      testCase({}),
      parsed({ intent: "similar_cheaper", text_slots: [["supurge"]] }),
    );
    expect(r).toMatchObject({
      anchorBrandAsFilter: false,
      markersLeaked: [],
      relationRecognized: true,
    });
  });

  it("dislama ve kontrol marka filtresini olcer", () => {
    const exclusion = scoreComparisonCase(
      testCase({ relation: "different_brand", exclude_brands: ["dyson"] }),
      parsed({ filters: { brand_include: ["dyson"] } }),
    );
    expect(exclusion.exclusionsKept).toBe(false);
    const control = scoreComparisonCase(
      testCase({ relation: null, anchor: null, anchor_brand: null, brand_include: ["dyson"] }),
      parsed({ filters: { brand_include: ["dyson"] } }),
    );
    expect(control.controlBrandKept).toBe(true);
    expect(control.anchorBrandAsFilter).toBeNull();
  });
});

describe("summarizeComparison", () => {
  it("iliskili ve kontrol vakalarini ayri oranlar", () => {
    const cases = [
      testCase({}, "a"),
      testCase({ relation: null, anchor: null, anchor_brand: null }, "b"),
    ];
    const results = [
      scoreComparisonCase(cases[0] as ComparisonCase, parsed({ text_slots: [["ucuz"]] })),
      scoreComparisonCase(cases[1] as ComparisonCase, parsed({ text_slots: [["ucuz"]] })),
    ];
    const s = summarizeComparison(cases, results);
    expect(s).toMatchObject({
      relationCases: 1,
      controlCases: 1,
      markerLeakRate: 1,
      controlMarkerLeakRate: 1,
      controlFalseRelationRate: 0,
    });
  });
});

describe("bugunku ayristirici, dev seti (regresyon korumasi)", () => {
  const lexicon: LexiconEntry[] = brandEntries(DEV.lexicon_brands);
  const results = DEV.cases.map((c) =>
    scoreComparisonCase(c, parsed(parseQueryText(c.q, lexicon))),
  );
  const summary = summarizeComparison(DEV.cases, results);

  it("kontrollerde duz marka filtresi ve 'olmasin' dislamasi korunur", () => {
    expect(summary.controlBrandKeptRate).toBe(1);
    expect(results.find((r) => r.id === "n04")?.exclusionsKept).toBe(true);
    expect(summary.controlFalseRelationRate).toBe(0);
  });
});
