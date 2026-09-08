import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "./lexicon.ts";
import { parseQueryText } from "./parse-query.ts";

const lexicon: LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "color", surface: "beyaz", normalized: "white", weight: 1 },
  { kind: "category", surface: "sneaker", normalized: "ayakkabi/sneaker", weight: 1 },
  { kind: "category", surface: "spor ayakkabı", normalized: "ayakkabi/sneaker", weight: 1 },
  { kind: "category", surface: "spor ayakkabısı", normalized: "ayakkabi/sneaker", weight: 1 },
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
];

describe("parseQueryText", () => {
  it("parses the C1 acceptance query into the documented filters", () => {
    const result = parseQueryText("3000 tl altı siyah spor ayakkabı 42 numara", lexicon);

    expect(result.filters).toEqual({
      category_path: "ayakkabi/sneaker",
      color: ["black"],
      price_max: 300000,
      size_norm: "42",
    });
    expect(result.unparsed).toBe("");
    expect(result.intent).toBe("browse");
    expect(result.anchor).toBeNull();
    expect(result.style_tags).toEqual([]);
    expect(result.sort).toBe("balanced");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("normalizes color casing consistently", () => {
    const a = parseQueryText("Siyah ayakkabı", lexicon);
    const b = parseQueryText("SİYAH ayakkabı", lexicon);
    expect(a.filters.color).toEqual(["black"]);
    expect(b.filters.color).toEqual(["black"]);
  });

  it("parses a price range", () => {
    const result = parseQueryText("2000-3000 arası ayakkabı", lexicon);
    expect(result.filters.price_min).toBe(200000);
    expect(result.filters.price_max).toBe(300000);
  });

  it("parses a letter size", () => {
    const result = parseQueryText("M beden ceket", lexicon);
    expect(result.filters.size_norm).toBe("m");
  });

  it("separates brand_include from brand_exclude, ignoring descriptive brand mentions", () => {
    const result = parseQueryText("nike tarzı spor ayakkabı ama nike olmasın", lexicon);
    expect(result.filters.brand_exclude).toEqual(["nike"]);
    expect(result.filters.brand_include).toBeUndefined();
    expect(result.filters.category_path).toBe("ayakkabi/sneaker");
  });

  it("returns a low-confidence best-effort result for unmatched text, never throwing", () => {
    const result = parseQueryText("geniş kalıp", lexicon);
    expect(result.filters).toEqual({});
    expect(result.unparsed).toBe("geniş kalıp");
    expect(result.confidence).toBeLessThan(0.35);
  });
});
