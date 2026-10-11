import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import type { SearchIntentPatch } from "./contract.ts";
import {
  describeLinkPreferences,
  linkPreferencesFromPatch,
  mergeLinkPreferences,
  parseLinkPreferences,
} from "./link-preference-text.ts";

const LEX: LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "siyah", weight: 1 },
  { kind: "color", surface: "black", normalized: "siyah", weight: 1 },
  { kind: "color", surface: "beyaz", normalized: "beyaz", weight: 1 },
  { kind: "style", surface: "spor", normalized: "spor", weight: 1 },
  { kind: "style", surface: "şık", normalized: "şık", weight: 1 },
  { kind: "material", surface: "deri", normalized: "deri", weight: 1 },
  { kind: "category", surface: "ayakkabı", normalized: "ayakkabi", weight: 1 },
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
];

describe("parseLinkPreferences", () => {
  it("leaves no leftover for plain similar/alternative requests (no false 'not understood' note)", () => {
    for (const text of [
      "Bu ürünün benzerlerini bul",
      "bunun benzerlerini göster",
      "bu ürünün alternatifleri neler",
      "bunun aynısını bul",
    ]) {
      const parsed = parseLinkPreferences(text, LEX);
      expect(parsed.leftover, text).toEqual([]);
      expect(parsed.preferences, text).toEqual({});
    }
  });

  it("reads inflected 'daha ucuzunu' and a case-suffixed category word without leftover", () => {
    const parsed = parseLinkPreferences("Bu ayakkabının daha ucuzunu bul", LEX);
    expect(parsed.preferences.sort).toBe("cheapest");
    expect(parsed.leftover).toEqual([]);
    expect(parseLinkPreferences("Bunun siyah alternatiflerini göster", LEX)).toMatchObject({
      preferences: { colors: ["siyah"] },
      leftover: [],
    });
    expect(parseLinkPreferences("daha ucuz olanlarını göster", LEX).leftover).toEqual([]);
  });

  it("still reports genuinely unknown words as leftover", () => {
    expect(parseLinkPreferences("bunun benzerlerini bul zımbırtılı", LEX).leftover).toEqual([
      "zımbırtılı",
    ]);
  });

  it("is empty for nothing recognizable", () => {
    const parsed = parseLinkPreferences("", LEX);
    expect(parsed).toMatchObject({ leftover: [], recognized: false, clearPrice: false });
    expect(parsed.preferences).toEqual({});
  });

  it("converts a price ceiling to kuruş (integer)", () => {
    const parsed = parseLinkPreferences("3000 TL altı olsun", LEX);
    expect(parsed.preferences.priceMaxKurus).toBe(300000);
    expect(parsed.leftover).toEqual([]);
    expect(parsed.recognized).toBe(true);
  });

  it("reads ranges and conversational budgets", () => {
    expect(parseLinkPreferences("2000-3000 arası", LEX).preferences).toMatchObject({
      priceMinKurus: 200000,
      priceMaxKurus: 300000,
    });
    expect(parseLinkPreferences("5 bine kadar", LEX).preferences.priceMaxKurus).toBe(500000);
  });

  it("'daha ucuz' means cheapest sort", () => {
    const parsed = parseLinkPreferences("daha ucuz olsun", LEX);
    expect(parsed.preferences.sort).toBe("cheapest");
    expect(parsed.leftover).toEqual([]);
    expect(parseLinkPreferences("daha uygun fiyatlı", LEX).preferences.sort).toBe("cheapest");
  });

  it("clears the price limit", () => {
    const parsed = parseLinkPreferences("fiyat sınırını kaldır", LEX);
    expect(parsed.clearPrice).toBe(true);
    expect(parsed.recognized).toBe(true);
    expect(parsed.leftover).toEqual([]);
  });

  it("maps colors (any surface) to the canonical lexicon form", () => {
    expect(parseLinkPreferences("black olsun", LEX).preferences.colors).toEqual(["siyah"]);
    expect(parseLinkPreferences("siyah ya da beyaz", LEX).preferences.colors).toEqual([
      "siyah",
      "beyaz",
    ]);
  });

  it("maps style and material", () => {
    expect(parseLinkPreferences("daha spor", LEX).preferences.styles).toEqual(["spor"]);
    expect(parseLinkPreferences("deri olsun", LEX).preferences.styles).toEqual(["deri"]);
    expect(parseLinkPreferences("daha spor", LEX).leftover).toEqual([]);
  });

  it("combines everything in one message", () => {
    const parsed = parseLinkPreferences("siyah, deri, 2500 TL altı, daha ucuz", LEX);
    expect(parsed.preferences).toEqual({
      colors: ["siyah"],
      styles: ["deri"],
      priceMaxKurus: 250000,
      sort: "cheapest",
    });
    expect(parsed.leftover).toEqual([]);
  });

  it("returns unrecognized meaningful words as leftover (stop words dropped)", () => {
    expect(parseLinkPreferences("ofiste giyebileceğim", LEX).leftover).toEqual([
      "ofiste",
      "giyebileceğim",
    ]);
    const parsed = parseLinkPreferences("aynı tarzda ama daha sade", LEX);
    expect(parsed.leftover).toEqual(["tarzda", "sade"]);
    expect(parsed.recognized).toBe(false);
  });

  it("brand and category words are topic words and count as leftover", () => {
    const parsed = parseLinkPreferences("nike ayakkabı olsun", LEX);
    expect(parsed.topicWords).toEqual(expect.arrayContaining(["nike", "ayakkabı"]));
    expect(parsed.leftover).toEqual(expect.arrayContaining(["nike", "ayakkabı"]));
  });

  it("works with an empty lexicon (colors become leftover)", () => {
    const parsed = parseLinkPreferences("siyah olsun", []);
    expect(parsed.preferences.colors).toBeUndefined();
    expect(parsed.leftover).toEqual(["siyah"]);
  });
});

describe("mergeLinkPreferences", () => {
  const base = { colors: ["siyah"], priceMaxKurus: 300000, sort: "cheapest" as const };

  it("a new price replaces the whole price", () => {
    const merged = mergeLinkPreferences(
      { ...base, priceMinKurus: 100000 },
      parseLinkPreferences("2000 TL altı", LEX),
    );
    expect(merged).toMatchObject({ priceMaxKurus: 200000, colors: ["siyah"], sort: "cheapest" });
    expect(merged.priceMinKurus).toBeUndefined();
  });

  it("a new color replaces the old one; sort stays", () => {
    const merged = mergeLinkPreferences(base, parseLinkPreferences("beyaz olsun", LEX));
    expect(merged).toMatchObject({ colors: ["beyaz"], sort: "cheapest", priceMaxKurus: 300000 });
  });

  it("clearPrice removes both bounds only", () => {
    const merged = mergeLinkPreferences(
      { ...base, priceMinKurus: 1000 },
      parseLinkPreferences("fiyat sınırını kaldır", LEX),
    );
    expect(merged).toEqual({ colors: ["siyah"], sort: "cheapest" });
  });

  it("an unrelated message changes nothing", () => {
    expect(mergeLinkPreferences(base, parseLinkPreferences("ofiste giyebileceğim", LEX))).toEqual(
      base,
    );
  });
});

describe("describeLinkPreferences", () => {
  it("renders Turkish phrases without forbidden words", () => {
    const parts = describeLinkPreferences({
      colors: ["siyah"],
      priceMaxKurus: 250000,
      sort: "cheapest",
    });
    expect(parts).toEqual(["siyah", "2.500 TL altı", "uygun fiyattan başlayarak"]);
    expect(parts.join(" ")).not.toMatch(/ucuz|satın al|dupe/);
  });
});

const patch = (extra: Partial<SearchIntentPatch>): SearchIntentPatch => ({
  reset: false,
  clear: false,
  remove: [],
  ...extra,
});

describe("linkPreferencesFromPatch", () => {
  it("keeps only lexicon-validated colors, styles, prices and cheapest sort", () => {
    expect(
      linkPreferencesFromPatch(
        patch({
          query: "ürün",
          category: "ayakkabı",
          brand: "Nike",
          excludeBrands: ["Adidas"],
          size: "42",
          colors: ["Siyah", "morumsu-yok"],
          attributes: { style: "Spor", anything: "uydurma", material: "deri" },
          priceMax: 2500,
          sort: "cheapest",
        }),
        LEX,
      ),
    ).toEqual({
      colors: ["siyah"],
      styles: ["spor", "deri"],
      priceMaxKurus: 250000,
      sort: "cheapest",
    });
  });

  it("drops everything not in the lexicon", () => {
    expect(
      linkPreferencesFromPatch(
        patch({ colors: ["turkuaz"], attributes: { style: "fütüristik" }, sort: "balanced" }),
        LEX,
      ),
    ).toEqual({});
  });
});
