import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import { emptyIntent } from "./intent.ts";
import { intentSearchText, intentSortMode, intentToQueryObject } from "./search-adapter.ts";

const lexicon: LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "category", surface: "ayakkabı", normalized: "ayakkabi", weight: 1 },
  { kind: "category", surface: "spor ayakkabı", normalized: "ayakkabi/sneaker", weight: 1 },
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
  { kind: "brand", surface: "puma", normalized: "puma", weight: 1 },
];

const intent = (overrides = {}) => ({ ...emptyIntent("günlük spor ayakkabı"), ...overrides });

describe("intentToQueryObject (thin adapter over the existing parser)", () => {
  it("maps free-text category, color and brand through the existing lexicon", () => {
    const q = intentToQueryObject(
      intent({ brand: "Nike", colors: ["siyah"], category: "ayakkabı" }),
      lexicon,
    );
    expect(q.filters.category_path).toBe("ayakkabi/sneaker");
    expect(q.filters.color).toEqual(["black"]);
    expect(q.filters.brand_include).toEqual(["nike"]);
  });

  it("uses the structured category when the query text did not resolve one", () => {
    const q = intentToQueryObject(intent({ query: "günlük", category: "ayakkabı" }), lexicon);
    expect(q.filters.category_path).toBe("ayakkabi");
  });

  it("does not turn an unknown category into a filter", () => {
    const q = intentToQueryObject(intent({ query: "günlük", category: "uzay gemisi" }), lexicon);
    expect(q.filters.category_path).toBeUndefined();
  });

  it("converts TL prices to integer kuruş, never floats", () => {
    const q = intentToQueryObject(intent({ priceMin: 1000, priceMax: 2500 }), lexicon);
    expect(q.filters.price_min).toBe(100_000);
    expect(q.filters.price_max).toBe(250_000);
    expect(Number.isInteger(q.filters.price_max)).toBe(true);
  });

  it("excludes a brand through the parser's own exclusion phrasing", () => {
    const q = intentToQueryObject(intent({ excludeBrands: ["Puma"] }), lexicon);
    expect(q.filters.brand_exclude).toEqual(["puma"]);
    expect(q.filters.brand_include).toBeUndefined();
  });

  it("does not duplicate a brand or color already present in the query", () => {
    expect(
      intentSearchText(intent({ query: "siyah nike ayakkabı", brand: "Nike", colors: ["siyah"] })),
    ).toBe("siyah nike ayakkabı");
  });

  it("maps the cheaper preference to the existing best_deal sort", () => {
    expect(intentSortMode(intent({ sort: "cheapest" }))).toBe("best_deal");
    expect(intentToQueryObject(intent({ sort: "cheapest" }), lexicon).sort).toBe("best_deal");
    expect(intentSortMode(intent())).toBe("balanced");
  });

  it("keeps the remaining text as the text gate (no invented products or ids)", () => {
    const q = intentToQueryObject(intent({ query: "lumbarzyx" }), lexicon);
    expect(q.unparsed).toBe("lumbarzyx");
    expect(q.anchor).toBeNull();
  });
});
