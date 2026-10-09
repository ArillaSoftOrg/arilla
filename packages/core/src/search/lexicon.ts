/**
 * `lexicon` tablosunun DB-bagimsiz karsiligi (docs/schema.sql,
 * packages/db/src/schema/search.ts). Ayristirici bu tipi kullanir; veri
 * canli DB'den (`lexicon-repository.ts`) veya test fixture'indan gelebilir.
 */
import { foldForMatch } from "./text-match.ts";

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

/** Harf, rakam ve bosluk disindaki karakterler (noktalama, isaret). */
const NON_WORD = /[^\p{L}\p{N}\s]/gu;

/**
 * Karsilastirma bicimi: metin kapisiyla ayni katlama (`foldForMatch`) ve
 * noktalama yerine bosluk. Her degisim AYNI uzunlukta yapilir; boylece bu
 * bicimdeki konumlar verilen metindeki konumlarla birebir aynidir.
 */
function comparable(text: string): string {
  return foldForMatch(text).replace(NON_WORD, (ch) => " ".repeat(ch.length));
}

const MULTI_WORD_CACHE_LIMIT = 10_000;
const multiWordPatterns = new Map<string, RegExp>();

/** Cok kelimeli yuzey: kelimeler arasinda bir ya da daha fazla bosluk/noktalama. */
function multiWordPattern(words: readonly string[]): RegExp {
  const key = words.join(" ");
  let pattern = multiWordPatterns.get(key);
  if (!pattern) {
    if (multiWordPatterns.size >= MULTI_WORD_CACHE_LIMIT) multiWordPatterns.clear();
    const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    pattern = new RegExp(escaped.join("\\s+"), "gu");
    multiWordPatterns.set(key, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
}

/**
 * Normalize edilmis metin icinde sozluk yuzeylerinin tum gecislerini bulur.
 * Kelime siniri kontrolu Turkce harfleri de kapsayacak sekilde `\p{L}`
 * kullanir - duz `\b` Turkce karakterlerde guvenilir degildir.
 *
 * Karsilastirma metin kapisiyla AYNI katlamayla yapilir (`foldForMatch`):
 * "kosu ayakkabisi" ile "koşu ayakkabısı", "kirmizi" ile "kırmızı" ayni
 * yuzeyi bulur. Cok kelimeli yuzeyin kelimeleri arasindaki bosluk/noktalama
 * farki onemsizdir ("koşu, ayakkabısı"). Donen `start`/`end` verilen `text`
 * uzerindeki konumlardir.
 */
export function findLexiconMatches(text: string, entries: readonly LexiconEntry[]): LexiconMatch[] {
  const matches: LexiconMatch[] = [];
  const haystack = comparable(text);
  const push = (entry: LexiconEntry, start: number, end: number) => {
    if (isBoundary(text[start - 1]) && isBoundary(text[end])) {
      matches.push({ entry, start, end });
    }
  };
  for (const entry of entries) {
    const words = comparable(entry.surface).split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.length > 1) {
      for (const found of haystack.matchAll(multiWordPattern(words))) {
        push(entry, found.index, found.index + found[0].length);
      }
      continue;
    }
    const surface = words[0] as string;
    let fromIndex = 0;
    for (;;) {
      const idx = haystack.indexOf(surface, fromIndex);
      if (idx === -1) break;
      push(entry, idx, idx + surface.length);
      fromIndex = idx + 1;
    }
  }
  return matches;
}
