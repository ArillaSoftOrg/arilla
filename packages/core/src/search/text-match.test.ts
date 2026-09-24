import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "./lexicon.ts";
import {
  allowedMisses,
  buildTextSlots,
  foldForMatch,
  MAX_QUERY_TOKENS,
  matchTokens,
  TOKEN_MATCH_THRESHOLD,
} from "./text-match.ts";

const synonym = (surface: string, normalized: string): LexiconEntry => ({
  kind: "synonym",
  surface,
  normalized,
  weight: 1,
});

const LEXICON: LexiconEntry[] = [
  synonym("kablosuz", "kablosuz"),
  synonym("wireless", "kablosuz"),
  synonym("sneaker", "sneaker"),
  synonym("spor ayakkabı", "sneaker"),
  // Esanlam OLMAYAN turler slot uretmez.
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
];

describe("foldForMatch", () => {
  it("folds Turkish to ASCII so 'hali' and 'halı' are the same query", () => {
    expect(foldForMatch("Halı")).toBe("hali");
    expect(foldForMatch("hali")).toBe("hali");
    expect(foldForMatch("ÇOCUK MONTU")).toBe("cocuk montu");
    expect(foldForMatch("IŞIK")).toBe("isik");
  });
});

describe("matchTokens", () => {
  it("keeps order (head noun last), drops 1-char tokens and duplicates", () => {
    expect(matchTokens("kadın omuz çantası")).toEqual(["kadin", "omuz", "cantasi"]);
    expect(matchTokens("a çanta çanta")).toEqual(["canta"]);
    expect(matchTokens("  ")).toEqual([]);
    expect(matchTokens(undefined)).toEqual([]);
  });

  it("caps very long queries but keeps the head noun", () => {
    const words = Array.from({ length: 12 }, (_, i) => `kelime${i}`);
    const tokens = matchTokens(words.join(" "));
    expect(tokens).toHaveLength(MAX_QUERY_TOKENS);
    expect(tokens.at(-1)).toBe("kelime11");
  });
});

describe("buildTextSlots", () => {
  it("expands synonym groups into one slot of alternatives", () => {
    expect(buildTextSlots("kablosuz mouse", LEXICON)).toEqual([
      ["kablosuz", "wireless"],
      ["mouse"],
    ]);
  });

  it("matches multi-word surfaces as a single slot, longest first", () => {
    expect(buildTextSlots("siyah spor ayakkabı", LEXICON)).toEqual([
      ["siyah"],
      ["spor ayakkabi", "sneaker"],
    ]);
  });

  it("ignores non-synonym lexicon kinds (they are filters, not text)", () => {
    expect(buildTextSlots("siyah", LEXICON)).toEqual([["siyah"]]);
  });

  it("returns no slots for empty text", () => {
    expect(buildTextSlots("", LEXICON)).toEqual([]);
  });
});

describe("gate rules", () => {
  it("requires every slot for 1-2 slot queries, allows one missing qualifier for 3+", () => {
    // "telefon kılıfı": bas isim "kılıfı" minder kılıfında eşleşir ama
    // "telefon" eksik -> sonuç yok. 3+ slotta bir niteleyici eksik olabilir.
    expect(allowedMisses(1)).toBe(0);
    expect(allowedMisses(2)).toBe(0);
    expect(allowedMisses(3)).toBe(1);
    expect(allowedMisses(5)).toBe(1);
  });

  it("uses the pg_trgm strict word similarity default so the indexed prefilter agrees", () => {
    expect(TOKEN_MATCH_THRESHOLD).toBe(0.5);
  });
});
