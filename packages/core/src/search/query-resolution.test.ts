import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "./lexicon.ts";
import { parseQueryText } from "./parse-query.ts";
import { isStaleResolution, QUERY_PARSER_VERSION } from "./query-resolution.ts";

const lexicon: LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "category", surface: "telefon", normalized: "elektronik/telefon", weight: 1 },
  { kind: "category", surface: "laptop", normalized: "elektronik/laptop", weight: 1 },
  { kind: "category", surface: "spor ayakkabı", normalized: "ayakkabi/sneaker", weight: 1 },
  { kind: "brand", surface: "samsung", normalized: "samsung", weight: 1 },
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
];

const CORPUS = [
  "3000 tl altı siyah spor ayakkabı 42 numara",
  "2000-3000 arası ayakkabı",
  "20 bin altı samsung telefon",
  "20k altı telefon",
  "15 bin ile 25 bin arası laptop",
  "en fazla 30k",
  "5000 TL'den ucuz",
  "10 bin üstü telefon",
  "iphone 17 pro max 60 bin altı",
  "iphone 17",
  "galaxy s24",
  "128gb",
  "256 gb ssd",
  "nike tarzı ama nike olmasın siyah",
  "M beden ceket",
];

/**
 * ALTIN OZET. `parseQueryText` ciktisi bu sabit korpusta degisirse test KIRILIR:
 * onbellekteki (`query_resolution`) satirlar eski anlami tasiyor demektir.
 *   1. `QUERY_PARSER_VERSION`'i artir (query-resolution.ts),
 *   2. asagidaki `EXPECTED` ozetini ve `EXPECTED_VERSION`'i guncelle.
 * Boylece eski satirlar bir sonraki okumada tek tek yenilenir; tablo silinmez.
 */
const EXPECTED_VERSION = 2;
const EXPECTED = "7ccb5422dbf7709d6ae029abfa224d421df6c4e32b683ec8e6357bd51c637973";

describe("query_resolution parser surumu", () => {
  it("ayristirici ciktisi degistiyse QUERY_PARSER_VERSION artirilmali (altin ozet)", () => {
    const outputs = CORPUS.map((text) => parseQueryText(text, lexicon));
    const digest = createHash("sha256").update(JSON.stringify(outputs)).digest("hex");
    expect(
      { digest, version: QUERY_PARSER_VERSION },
      "Ayristirici ciktisi degisti: QUERY_PARSER_VERSION'i artir, EXPECTED ozetini ve EXPECTED_VERSION'i guncelle",
    ).toEqual({ digest: EXPECTED, version: EXPECTED_VERSION });
  });

  it("yalniz 2. kademe ve eski/damgasiz surumlu satir bayat sayilir", () => {
    const parsed = (version?: unknown) => ({ filters: {}, parser_version: version });
    expect(isStaleResolution({ parserTier: 2, parsed: { filters: {} } })).toBe(true);
    expect(isStaleResolution({ parserTier: 2, parsed: parsed(1) })).toBe(true);
    expect(isStaleResolution({ parserTier: 2, parsed: parsed("2") })).toBe(true);
    expect(isStaleResolution({ parserTier: 2, parsed: parsed(QUERY_PARSER_VERSION) })).toBe(false);
    // Daha yeni surum (geri alinan dagitim): yeniden yazilmaz, sallanma olmaz.
    expect(isStaleResolution({ parserTier: 2, parsed: parsed(QUERY_PARSER_VERSION + 1) })).toBe(
      false,
    );
    // Model kademesi (3) hicbir zaman bayat degildir: dokunulmaz.
    expect(isStaleResolution({ parserTier: 3, parsed: { filters: {} } })).toBe(false);
  });
});
