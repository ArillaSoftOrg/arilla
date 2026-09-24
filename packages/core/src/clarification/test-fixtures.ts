import type { LexiconEntry } from "../search/lexicon.ts";
import type { ExtractContext } from "./extract.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "./rules.ts";

/** Kademe 2 sozlugunun kucuk bir kesiti; gercekte `loadLexicon(db)`'den gelir. */
export const TEST_LEXICON: readonly LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "color", surface: "beyaz", normalized: "white", weight: 1 },
  { kind: "color", surface: "kırmızı", normalized: "red", weight: 1 },
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
  { kind: "brand", surface: "apple", normalized: "apple", weight: 1 },
];

/** packages/db/migrations/0016_category_expansion.sql + tohum agaci. */
export const TEST_CATEGORY_PATHS: ReadonlySet<string> = new Set([
  "moda",
  "moda/ayakkabi",
  "elektronik",
  "ev-yasam",
  "anne-bebek",
  "kitap-muzik-hobi",
  "spor-outdoor",
  "oto-bahce",
  "saglik-kozmetik",
  "saglik-kozmetik/kozmetik",
  "petshop",
  "supermarket",
]);

export const TEST_CONTEXT: ExtractContext = {
  registry: DEFAULT_CLARIFICATION_REGISTRY,
  lexicon: TEST_LEXICON,
};
