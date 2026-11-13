import { describe, expect, it } from "vitest";
import { applyIntentPlan, type IntentSearchPlan } from "../intent/to-search.ts";
import {
  categoryConstraint,
  downgradeCategoryToHint,
  parseUiCategoryParam,
  selectorCategory,
  verifyTextCategory,
  withCategoryHint,
  withExplicitUiCategory,
} from "./category-source.ts";
import { constraintLadder } from "./fallback/stages.ts";
import { selectSemanticStrategy } from "./semantic/strategy.ts";
import type { QueryFilters, QueryObject } from "./types.ts";

const KNOWN = new Set(["moda", "moda/ayakkabi", "moda/ayakkabi/spor-ayakkabi"]);

function query(filters: QueryFilters): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: "x",
    filters,
    style_tags: [],
    sort: "balanced",
    unparsed: "",
    confidence: 1,
  };
}

function plan(filters: QueryFilters, hintCategory: string | null = null): IntentSearchPlan {
  return {
    filters,
    hints: {
      role: null,
      category: hintCategory,
      compatibleWith: null,
      required: [],
      preferred: [],
      excluded: [],
      brands: [],
    },
    display: [],
  };
}

describe("categoryConstraint (karar 0190)", () => {
  it("explicit_ui: kesin ve gevsetilemez", () => {
    expect(
      categoryConstraint({ category_path: "moda/ayakkabi", category_source: "explicit_ui" }),
    ).toEqual({
      hardPath: "moda/ayakkabi",
      softPath: null,
      source: "explicit_ui",
      relaxable: false,
    });
  });

  it("explicit_text_verified: kesin, ust kategoriye gevsetilebilir", () => {
    const c = categoryConstraint({
      category_path: "moda/ayakkabi",
      category_source: "explicit_text_verified",
    });
    expect(c.hardPath).toBe("moda/ayakkabi");
    expect(c.relaxable).toBe(true);
  });

  it("kaynagi bilinmeyen yol: legacy (metinde kesin, acik SAYILMAZ)", () => {
    const c = categoryConstraint({ category_path: "moda/ayakkabi" });
    expect(c.source).toBe("legacy");
    expect(c.hardPath).toBe("moda/ayakkabi");
    expect(selectorCategory({ category_path: "moda/ayakkabi" })).toEqual({
      path: "moda/ayakkabi",
      source: "inferred",
    });
  });

  it("ipucu: yalniz yumusak", () => {
    expect(categoryConstraint({ category_hint: "moda" })).toEqual({
      hardPath: null,
      softPath: "moda",
      source: "inferred",
      relaxable: true,
    });
  });

  it("kesin yol varken ipucu yok sayilir", () => {
    expect(
      categoryConstraint({
        category_path: "moda",
        category_source: "explicit_ui",
        category_hint: "elektronik",
      }).softPath,
    ).toBeNull();
  });

  it("hic kategori yok: none", () => {
    expect(categoryConstraint({}).source).toBe("none");
    expect(selectorCategory({})).toBeNull();
  });
});

describe("secici esleme: yalniz yazilmis acik kaynak kesin filtredir", () => {
  const base = {
    modelVersion: "m",
    hasPriceFilter: false,
    inventory: [],
    categoryStats: null,
    now: new Date("2026-11-13T00:00:00Z"),
  };
  it.each([
    [{ category_path: "moda", category_source: "explicit_ui" } as QueryFilters, "hard"],
    [{ category_path: "moda", category_source: "explicit_text_verified" } as QueryFilters, "hard"],
    [{ category_path: "moda" } as QueryFilters, "soft"],
    [{ category_hint: "moda" } as QueryFilters, "soft"],
    [{} as QueryFilters, "none"],
  ])("%j -> %s", (filters, mode) => {
    const d = selectSemanticStrategy({ ...base, category: selectorCategory(filters) });
    expect(d.categoryMode).toBe(mode);
    expect(d.uncategorized).toBe(
      mode === "hard" ? "excluded" : mode === "soft" ? "secondary_candidates" : "included",
    );
  });
});

describe("dogrulama ve donusum", () => {
  it("katalogda olmayan metin kategorisi ipucuna duser", () => {
    expect(
      verifyTextCategory(
        { category_path: "moda/uzay", category_source: "explicit_text_verified", color: ["black"] },
        KNOWN,
      ),
    ).toEqual({ category_hint: "moda/uzay", color: ["black"] });
  });

  it("katalogda olan metin kategorisi kesin kalir", () => {
    const f: QueryFilters = { category_path: "moda", category_source: "explicit_text_verified" };
    expect(verifyTextCategory(f, KNOWN)).toBe(f);
  });

  it("agac okunamadiysa bugunku davranis korunur; legacy ve explicit_ui'ye dokunulmaz", () => {
    const text: QueryFilters = { category_path: "x", category_source: "explicit_text_verified" };
    expect(verifyTextCategory(text, null)).toBe(text);
    const legacy: QueryFilters = { category_path: "x" };
    expect(verifyTextCategory(legacy, KNOWN)).toBe(legacy);
    const ui: QueryFilters = { category_path: "x", category_source: "explicit_ui" };
    expect(verifyTextCategory(ui, KNOWN)).toBe(ui);
  });

  it("downgrade kaynagi siler, ipucu yazar", () => {
    expect(downgradeCategoryToHint({ category_path: "a", category_source: "explicit_ui" })).toEqual(
      { category_hint: "a" },
    );
    expect(downgradeCategoryToHint({ price_max: 5 })).toEqual({ price_max: 5 });
  });

  it("ipucu kesin yolu ya da eski ipucunu ezmez", () => {
    expect(withCategoryHint({ category_path: "a" }, "b")).toEqual({ category_path: "a" });
    expect(withCategoryHint({ category_hint: "a" }, "b")).toEqual({ category_hint: "a" });
    expect(withCategoryHint({}, "b")).toEqual({ category_hint: "b" });
    expect(withCategoryHint({}, undefined)).toEqual({});
  });

  it("arayuz secimi metin kategorisini ve ipucunu ezer", () => {
    expect(
      withExplicitUiCategory(
        { category_path: "a", category_source: "explicit_text_verified", category_hint: "c" },
        "moda",
      ),
    ).toEqual({ category_path: "moda", category_source: "explicit_ui" });
  });
});

describe("parseUiCategoryParam: guvenli bicim", () => {
  it.each([
    ["moda/ayakkabi", "moda/ayakkabi"],
    [" Moda/Ayakkabi ", "moda/ayakkabi"],
    [["moda", "elektronik"], "moda"],
    ["moda%", null],
    ["moda_x", null],
    ["moda/'; DROP TABLE product;--", null],
    ["../moda", null],
    ["", null],
    [undefined, null],
    ["a".repeat(201), null],
  ])("%j -> %j", (raw, expected) => {
    expect(parseUiCategoryParam(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe("fallback: explicit_ui gevsetilmez", () => {
  it("explicit_ui kategori ust kategoriye cikmaz", () => {
    const steps = constraintLadder(
      { category_path: "moda/ayakkabi/spor-ayakkabi", category_source: "explicit_ui" },
      [],
    );
    expect(steps.every((s) => s.filters.category_path === "moda/ayakkabi/spor-ayakkabi")).toBe(
      true,
    );
    expect(steps.some((s) => s.relaxed.includes("category"))).toBe(false);
  });

  it("explicit_text_verified bugunku gibi ust kategoriye gevser (kok haric)", () => {
    const steps = constraintLadder(
      { category_path: "moda/ayakkabi/spor-ayakkabi", category_source: "explicit_text_verified" },
      [],
    );
    expect(steps.map((s) => s.filters.category_path)).toEqual(["moda/ayakkabi"]);
  });
});

describe("IntentV2 plani kaynagi tasir", () => {
  it("H kategori kaynakla birlikte bos alana girer", () => {
    const merged = applyIntentPlan(
      query({}),
      plan({ category_path: "moda/ayakkabi", category_source: "explicit_text_verified" }),
    );
    expect(merged.filters).toEqual({
      category_path: "moda/ayakkabi",
      category_source: "explicit_text_verified",
    });
  });

  it("deterministik kesin yol ve kaynagi korunur", () => {
    const merged = applyIntentPlan(
      query({ category_path: "moda", category_source: "explicit_ui" }),
      plan({ category_path: "elektronik", category_source: "explicit_text_verified" }, "x"),
    );
    expect(merged.filters).toEqual({ category_path: "moda", category_source: "explicit_ui" });
  });

  it("R kategori yalniz ipucu olur", () => {
    const merged = applyIntentPlan(query({ price_max: 10 }), plan({}, "moda/ayakkabi"));
    expect(merged.filters).toEqual({ price_max: 10, category_hint: "moda/ayakkabi" });
  });
});
