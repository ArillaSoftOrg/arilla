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
  { kind: "brand", surface: "samsung", normalized: "samsung", weight: 1 },
  { kind: "category", surface: "telefon", normalized: "elektronik/telefon", weight: 1 },
  { kind: "category", surface: "laptop", normalized: "elektronik/laptop", weight: 1 },
];

describe("parseQueryText", () => {
  it("parses the C1 acceptance query into the documented filters", () => {
    const result = parseQueryText("3000 tl altı siyah spor ayakkabı 42 numara", lexicon);

    expect(result.filters).toEqual({
      category_path: "ayakkabi/sneaker",
      color: ["black"],
      price_max: 300000,
      currency: "TRY",
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

  describe("deterministic price phrases (no model call)", () => {
    const cases: Array<[string, Partial<{ min: number; max: number }>, string]> = [
      ["20 bin altı telefon", { max: 2_000_000 }, "telefon"],
      ["20k altı telefon", { max: 2_000_000 }, "telefon"],
      ["20.000 TL altı telefon", { max: 2_000_000 }, "telefon"],
      ["15 bin ile 25 bin arası laptop", { min: 1_500_000, max: 2_500_000 }, "laptop"],
      ["en fazla 30k laptop", { max: 3_000_000 }, "laptop"],
      ["5000 TL'den ucuz telefon", { max: 500_000 }, "telefon"],
      ["10 bin üstü telefon", { min: 1_000_000 }, "telefon"],
      ["20 bin altı samsung telefon", { max: 2_000_000 }, "telefon"],
    ];

    it.each(cases)("%s", (text, expected, category) => {
      const result = parseQueryText(text, lexicon);
      expect(result.filters.price_min ?? undefined).toBe(expected.min);
      expect(result.filters.price_max ?? undefined).toBe(expected.max);
      expect(result.filters.currency).toBe("TRY");
      expect(result.filters.category_path).toBe(`elektronik/${category}`);
      // Fiyat ifadesi metin kapisina sizmaz.
      expect(result.unparsed).toBe("");
    });

    it("keeps model numbers and specs out of the price filters", () => {
      for (const text of [
        "iphone 17 pro max",
        "iphone 17 telefon",
        "samsung s24 telefon",
        "128gb telefon",
        "256 gb ssd laptop",
        "5000 mah telefon",
        "iphone 17 altı telefon",
        "en az 16 gb ram laptop",
      ]) {
        const result = parseQueryText(text, lexicon);
        expect(result.filters.price_min, text).toBeUndefined();
        expect(result.filters.price_max, text).toBeUndefined();
        expect(result.filters.currency, text).toBeUndefined();
      }
    });

    it("reads the price but not the model number in a mixed query", () => {
      const result = parseQueryText("iphone 17 pro max 256 gb 60 bin altı", lexicon);
      expect(result.filters.price_max).toBe(6_000_000);
      expect(result.unparsed).toBe("iphone 17 pro max 256 gb");
    });
  });
});
