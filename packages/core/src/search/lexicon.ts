/**
 * `lexicon` tablosunun DB-bagimsiz karsiligi (docs/schema.sql,
 * packages/db/src/schema/search.ts). Ayristirici bu tipi kullanir; veri
 * canli DB'den (`lexicon-repository.ts`) veya test fixture'indan gelebilir.
 */
import { foldTurkish } from "./normalize.ts";

export type LexiconKind =
  | "color"
  | "category"
  | "brand"
  | "size"
  | "material"
  | "style"
  /** Filtre uretmez; metin kapisinda ayni `normalized`i paylasan yuzeyler alternatif olur (0029). */
  | "synonym";

export interface LexiconEntry {
  kind: LexiconKind;
  /** 'spor ayakkabı' */
  surface: string;
  /** 'ayakkabi/sneaker' */
  normalized: string;
  weight: number;
}

export interface LexiconMatch {
  entry: LexiconEntry;
  start: number;
  end: number;
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || !isWordChar(char);
}

/**
 * Normalize edilmis metin icinde sozluk yuzeylerinin tum gecislerini bulur.
 * Kelime siniri kontrolu Turkce harfleri de kapsayacak sekilde `\p{L}`
 * kullanir - duz `\b` Turkce karakterlerde guvenilir degildir.
 */
export function findLexiconMatches(text: string, entries: readonly LexiconEntry[]): LexiconMatch[] {
  const matches: LexiconMatch[] = [];
  for (const entry of entries) {
    const surface = foldTurkish(entry.surface);
    if (!surface) continue;
    let fromIndex = 0;
    for (;;) {
      const idx = text.indexOf(surface, fromIndex);
      if (idx === -1) break;
      const end = idx + surface.length;
      if (isBoundary(text[idx - 1]) && isBoundary(text[end])) {
        matches.push({ entry, start: idx, end });
      }
      fromIndex = idx + 1;
    }
  }
  return matches;
}
