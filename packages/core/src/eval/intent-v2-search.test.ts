import { describe, expect, it } from "vitest";
import type { IntentV2Case, IntentV2Gold } from "./intent-v2-eval.ts";
import {
  type IntentSearchRow,
  measureItems,
  planFromGold,
  summarizeIntentSearch,
} from "./intent-v2-search.ts";

function gold(over: Partial<IntentV2Gold> = {}): IntentV2Gold {
  return {
    type: null,
    type_id: null,
    category: null,
    role: null,
    brand: null,
    compat: null,
    budget: null,
    attrs: [],
    exclude_brands: [],
    clarify: false,
    ...over,
  };
}

const kase = (g: IntentV2Gold): IntentV2Case => ({
  id: "x",
  cat: "c",
  lang: "tr",
  typo: false,
  q: "q",
  gold: g,
});

const item = (
  productId: number,
  title: string,
  minPrice: number | null,
  brandName: string | null = null,
) => ({
  productId,
  title,
  minPrice,
  brandName,
});

describe("planFromGold", () => {
  it("butce TL -> kurus; marka ve haric marka filtre; uyumluluk yalniz ipucu", () => {
    const p = planFromGold(
      gold({
        role: "accessory",
        brand: "Anker",
        compat: "iPhone 15",
        budget: [null, 500],
        exclude_brands: ["Xiaomi"],
        attrs: [["connectivity", "kablosuz", "excluded"]],
      }),
    );
    expect(p.filters).toEqual({
      price_max: 50_000,
      brand_include: ["anker"],
      brand_exclude: ["xiaomi"],
    });
    expect(p.hints.compatibleWith).toBe("iphone 15");
    expect(p.hints.excluded).toEqual(["kablosuz"]);
  });

  it("type_id kategori filtresine yalniz ana urunde doner", () => {
    expect(planFromGold(gold({ role: "main", type_id: "laptop" })).filters.category_path).toBe(
      "elektronik",
    );
    expect(
      planFromGold(gold({ role: "accessory", type_id: "laptop" })).filters.category_path,
    ).toBeUndefined();
  });

  it("oznitelikler asla filtre olmaz", () => {
    const p = planFromGold(gold({ attrs: [["refresh_rate", "144 Hz", "required"]] }));
    expect(p.filters).toEqual({});
  });
});

describe("measureItems", () => {
  it("butce ihlali, haric isabet, uyum kademesi; fiyatsiz urun ihlal sayilmaz", () => {
    const m = measureItems(
      kase(
        gold({
          budget: [null, 1000],
          compat: "iphone 15",
          attrs: [["connectivity", "kablosuz", "excluded"]],
          exclude_brands: ["xiaomi"],
        }),
      ),
      [
        item(1, "iPhone 15 Kablolu Kulaklık", 90_000),
        item(2, "Kablosuz Şarj Standı", 150_000),
        item(3, "Telefon Tutucu", null, "Xiaomi"),
        item(4, "iPhone 13 Kılıf", 20_000),
      ],
      "exact",
    );
    expect(m.budgetViolations).toBe(1);
    expect(m.excludedHits).toBe(2);
    expect(m.compatTiers).toEqual([1, 2, 1]);
    expect(m.topIds).toEqual([1, 2, 3, 4]);
  });

  it("bos sonuc", () => {
    const m = measureItems(kase(gold()), [], "empty");
    expect(m.zero).toBe(true);
    expect(m.compatTiers).toBeNull();
  });
});

describe("summarizeIntentSearch", () => {
  const metrics = (ids: number[], extra = {}) => ({
    returned: ids.length,
    zero: ids.length === 0,
    stage: "exact",
    topIds: ids,
    budgetViolations: 0,
    excludedHits: 0,
    compatTiers: null,
    ...extra,
  });
  it("(b)'nin bosalttigi vaka ve ayni ilk 10 sayilir", () => {
    const rows: IntentSearchRow[] = [
      {
        id: "r1",
        cat: "c",
        planApplied: false,
        hasBudget: false,
        hasExcluded: false,
        a: metrics([1, 2]),
        b: metrics([1, 2]),
        overlap10: 2,
      },
      {
        id: "r2",
        cat: "c",
        planApplied: true,
        hasBudget: true,
        hasExcluded: false,
        a: metrics([3], { budgetViolations: 1 }),
        b: metrics([]),
        overlap10: 0,
      },
    ];
    const s = summarizeIntentSearch(rows);
    expect(s.identicalTop10).toBe(1);
    expect(s.bEmptiedA).toEqual(["r2"]);
    expect(s.budgetCases).toBe(1);
    expect(s.budgetViolatedA).toBe(1);
    expect(s.budgetViolatedB).toBe(0);
    expect(s.meanOverlap10).toBe(1);
  });
});
