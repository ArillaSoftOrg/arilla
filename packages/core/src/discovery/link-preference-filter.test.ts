import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import {
  applyCategoryGate,
  applyPreferences,
  type CandidateFacts,
  expandTerms,
  resolveCategoryPath,
  styleValuesOf,
} from "./link-preference-filter.ts";

const lexicon: LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "color", surface: "black", normalized: "black", weight: 1 },
  { kind: "style", surface: "spor", normalized: "sporty", weight: 1 },
  { kind: "category", surface: "ayakkabı", normalized: "moda/ayakkabi", weight: 1 },
  { kind: "category", surface: "spor ayakkabı", normalized: "moda/ayakkabi/sneaker", weight: 1 },
  { kind: "category", surface: "çanta", normalized: "moda/canta", weight: 1 },
];

function fact(productId: number, partial: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    productId,
    minPrice: null,
    color: null,
    attributes: null,
    categoryPath: null,
    ...partial,
  };
}

const items = (...ids: number[]) =>
  ids.map((productId, index) => ({ productId, score: 1 - index * 0.1 }));

function run(
  similar: { productId: number; score: number }[],
  facts: CandidateFacts[],
  preferences: Parameters<typeof applyPreferences>[0]["preferences"],
  extra: { same?: { productId: number }[] } = {},
) {
  return applyPreferences({
    similar,
    same: extra.same ?? [],
    facts: new Map(facts.map((f) => [f.productId, f])),
    preferences,
    colorTerms: expandTerms(preferences.colors ?? [], lexicon, ["color"]),
    styleTerms: expandTerms(preferences.styles ?? [], lexicon, ["style", "material"]),
  });
}

describe("price preference", () => {
  const facts = [
    fact(1, { minPrice: 50_000 }),
    fact(2, { minPrice: 150_000 }),
    fact(3, { minPrice: null }),
  ];

  it("filters by range and drops candidates without a price", () => {
    const result = run(items(1, 2, 3), facts, { priceMaxKurus: 100_000 });
    expect(result.similar.map((i) => i.productId)).toEqual([1]);
    expect(result.outcome).toEqual({ applied: ["price"], unapplied: [], droppedByPreferences: 2 });
  });

  it("applies a minimum bound", () => {
    const result = run(items(1, 2), facts, { priceMinKurus: 100_000 });
    expect(result.similar.map((i) => i.productId)).toEqual([2]);
  });

  it("is unapplied (and filters nothing) when no candidate has a price", () => {
    const result = run(items(3, 4), [fact(3), fact(4)], { priceMaxKurus: 100 });
    expect(result.similar.map((i) => i.productId)).toEqual([3, 4]);
    expect(result.outcome).toEqual({ applied: [], unapplied: ["price"], droppedByPreferences: 0 });
  });
});

describe("cheapest sort", () => {
  it("orders eligible candidates by price and keeps score as tiebreak", () => {
    const facts = [
      fact(1, { minPrice: 300 }),
      fact(2, { minPrice: 100 }),
      fact(3, { minPrice: 100 }),
      fact(4, { minPrice: 900 }),
    ];
    const result = run(items(1, 2, 3, 4), facts, { sort: "cheapest", priceMaxKurus: 500 });
    expect(result.similar.map((i) => i.productId)).toEqual([2, 3, 1]);
    expect(result.outcome.applied).toEqual(["price", "sort"]);
  });

  it("never adds candidates that were not in the pool", () => {
    const result = run(items(1), [fact(1, { minPrice: 10 })], { sort: "cheapest" });
    expect(result.similar.map((i) => i.productId)).toEqual([1]);
  });
});

describe("color preference", () => {
  it("matches canonical color through lexicon synonyms", () => {
    const facts = [fact(1, { color: "black" }), fact(2, { color: "beige" }), fact(3)];
    const result = run(items(1, 2, 3), facts, { colors: ["siyah"] });
    expect(result.similar.map((i) => i.productId)).toEqual([1]);
    expect(result.outcome).toEqual({ applied: ["color"], unapplied: [], droppedByPreferences: 2 });
  });

  it("goes to unapplied when no candidate has color data", () => {
    const result = run(items(1, 2), [fact(1), fact(2)], { colors: ["black"] });
    expect(result.similar).toHaveLength(2);
    expect(result.outcome).toEqual({ applied: [], unapplied: ["color"], droppedByPreferences: 0 });
  });

  it("counts color data of the same-product list as pool data", () => {
    const result = run(
      items(1),
      [fact(1), fact(9, { color: "black" })],
      {
        colors: ["black"],
      },
      { same: [{ productId: 9 }] },
    );
    expect(result.outcome.applied).toEqual(["color"]);
    expect(result.similar).toEqual([]);
  });
});

describe("style preference", () => {
  it("reads only style/material attribute keys", () => {
    expect(styleValuesOf({ style: "Spor", material: ["Deri"], foo: "x" })).toEqual([
      "spor",
      "deri",
    ]);
    expect(styleValuesOf(null)).toEqual([]);
  });

  it("matches attributes and drops candidates without them", () => {
    const facts = [
      fact(1, { attributes: { style: "spor" } }),
      fact(2, { attributes: { material: "deri" } }),
      fact(3, { attributes: {} }),
    ];
    const result = run(items(1, 2, 3), facts, { styles: ["sporty"] });
    expect(result.similar.map((i) => i.productId)).toEqual([1]);
    expect(result.outcome.applied).toEqual(["style"]);
  });

  it("is unapplied when the catalog has no style data", () => {
    const result = run(items(1), [fact(1, { attributes: { color: "x" } })], { styles: ["spor"] });
    expect(result.similar).toHaveLength(1);
    expect(result.outcome.unapplied).toEqual(["style"]);
  });
});

describe("category resolution and gate", () => {
  it("resolves a single unambiguous category", () => {
    expect(resolveCategoryPath("Spor Ayakkabı", lexicon)).toBe("moda/ayakkabi/sneaker");
  });

  it("picks the widest path when matches lie on one chain", () => {
    expect(resolveCategoryPath("Ayakkabı > Spor Ayakkabı", lexicon)).toBe("moda/ayakkabi");
  });

  it("returns null for ambiguous or unknown categories", () => {
    expect(resolveCategoryPath("Çanta ve Ayakkabı", lexicon)).toBeNull();
    expect(resolveCategoryPath("Bilinmeyen Şey", lexicon)).toBeNull();
    expect(resolveCategoryPath(null, lexicon)).toBeNull();
  });

  it("drops known out-of-category candidates but keeps uncategorised ones", () => {
    const facts = new Map(
      [
        fact(1, { categoryPath: "moda/ayakkabi/sneaker" }),
        fact(2, { categoryPath: "moda/canta" }),
        fact(3),
      ].map((f) => [f.productId, f]),
    );
    const kept = applyCategoryGate(items(1, 2, 3), facts, "moda/ayakkabi");
    expect(kept.map((i) => i.productId)).toEqual([1, 3]);
  });

  it("does not gate when no candidate is inside the category", () => {
    const facts = new Map([fact(2, { categoryPath: "moda/canta" })].map((f) => [f.productId, f]));
    expect(applyCategoryGate(items(2), facts, "moda/ayakkabi")).toHaveLength(1);
    expect(applyCategoryGate(items(2), facts, null)).toHaveLength(1);
  });
});
