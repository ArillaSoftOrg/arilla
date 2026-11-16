/**
 * Sorgu analizi: normalizasyon + token siniflari. Saf fonksiyon (DB, ag,
 * model yok).
 *
 * Mevcut `matchTokens` tek karakterli tokenlari atar ("playstation 5" -> "5"
 * kaybolur) ve sayi/birim birlesimini bilmez ("128 gb" / "128gb"). Fallback'in
 * dogrulugu tam bu tokenlara baglidir ("17", "pro", "max"), bu yuzden burada
 * onlari KORUYAN ayri bir tokenizasyon var. Metin kapisi icin kullanilan
 * katlama (`foldForMatch`) ayni; iki taraf ayni dili konusur.
 */

import { isModelDetail, VARIANT_WORDS } from "../query-shape.ts";
import { textSlotsOf } from "../search-sql.ts";
import { headTypeToken } from "../semantic/product-type.ts";
import { foldForMatch } from "../text-match.ts";
import type { QueryObject } from "../types.ts";
import { type AliasSource, NO_ALIASES } from "./aliases.ts";

/**
 * - `model`: sayi ya da sayi iceren kod ("17", "s24", "128gb", "5g"). Urunde
 *   AYNEN bulunmali; "17" aranirken "16" bulanik yakin sayilmaz.
 * - `variant`: ayni modelin surum eki ("pro", "max", "plus", "ultra" ...).
 *   Kisa, kapali bir kume: sorgu tokenlarini silmeyiz ama gevsetme sirasinda
 *   once bunlar birakilir.
 * - `word`: geri kalan her sey.
 */
export type TokenKind = "model" | "variant" | "word";

export interface QueryToken {
  /** Katlanmis; birden fazla kelimeli es anlamli yuzey bosluk icerebilir. */
  value: string;
  alternatives: string[];
  kind: TokenKind;
  /** Sorgudaki orijinal sira (urun turu sona alinsa da korunur; gevsetmede "tura en yakin" icin). */
  pos?: number;
}

export { VARIANT_WORDS };

export const UNIT_WORDS: ReadonlySet<string> = new Set([
  "gb",
  "tb",
  "mb",
  "ml",
  "cl",
  "lt",
  "cm",
  "mm",
  "kg",
  "gr",
  "mah",
  "inc",
  "inch",
  "w",
]);

const NUMERIC_RE = /^\d+$/u;
const HAS_DIGIT_RE = /\d/u;
/** 128gb, 256gb, 1tb: depolama/hacim gibi sonradan birakilabilen ozellik kodu. */
const SPEC_RE = /^\d+(?:gb|tb|mb|ml|cl|lt|cm|mm|kg|gr|mah|inc|inch|w)$/u;

export function isSpecToken(token: QueryToken): boolean {
  return token.kind === "model" && SPEC_RE.test(token.value);
}

/** Harf/rakam disini bosluk yapar, sayi + birim komsulugunu birlestirir. */
export function wordsOf(text: string): string[] {
  const raw = foldForMatch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  const words: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i] as string;
    const next = raw[i + 1];
    if (NUMERIC_RE.test(word) && next !== undefined && UNIT_WORDS.has(next)) {
      words.push(`${word}${next}`);
      i += 1;
      continue;
    }
    words.push(word);
  }
  return words;
}

function kindOf(word: string): TokenKind {
  if (HAS_DIGIT_RE.test(word)) return "model";
  if (VARIANT_WORDS.has(word)) return "variant";
  return "word";
}

/** Tek harfli sozcuk gurultudur; tek haneli sayi ("playstation 5") degildir. */
function keepWord(word: string): boolean {
  return word.length >= 2 || NUMERIC_RE.test(word);
}

export interface QueryAnalysis {
  /** Katlanmis, tekrarsiz ve sirali; log/gozlem icin. */
  normalized: string;
  tokens: QueryToken[];
}

/**
 * Metin kapisina kalan (`unparsed`) kelimeler. Marka/renk/kategori/fiyat
 * ayristiricinin filtresine donustu; onlar `filters`ta yasar, burada degil.
 * `text_slots`taki es anlamli alternatifler ilgili tokene eklenir.
 */
export function analyzeQuery(
  parsed: QueryObject,
  aliases: AliasSource = NO_ALIASES,
): QueryAnalysis {
  const words = wordsOf(parsed.unparsed).filter(keepWord);

  // Es anlamli slotlari (cok kelimeli olabilir) ardisik kelimelerle eslestir.
  const synonymSlots = textSlotsOf(parsed).filter((slot) => slot.length > 1);
  const tokens: QueryToken[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < words.length; ) {
    const slot = synonymSlots.find((candidate) => {
      const phrase = (candidate[0] as string).split(" ");
      return phrase.every((word, offset) => words[i + offset] === word);
    });
    const span = slot ? (slot[0] as string).split(" ").length : 1;
    const value = slot ? (slot[0] as string) : (words[i] as string);
    i += span;
    if (seen.has(value)) continue;
    seen.add(value);
    const alternatives = new Set<string>(slot ? slot.slice(1) : []);
    if (!slot) for (const alt of aliases.expand(value)) alternatives.add(alt);
    alternatives.delete(value);
    tokens.push({
      value,
      alternatives: [...alternatives],
      kind: slot ? "word" : kindOf(value),
      pos: tokens.length,
    });
  }
  const ordered = headTypeLast(tokens, headTypeToken(parsed.text));
  return { normalized: ordered.map((token) => token.value).join(" "), tokens: ordered };
}

/**
 * Urun turu belirteci sonda degilse ve ardindan yalniz niteleyici kelimeler geliyorsa ("dikey supurge
 * hafif") onu sona alir (karar 0214; slotlardaki `headTypeFirst` ile ayni kural). Model ayrintisi
 * (sayi, surum eki) izliyorsa dokunmaz ("iphone 17 pro max").
 */
export function headTypeLast(tokens: QueryToken[], typeToken: string | null): QueryToken[] {
  if (typeToken === null || tokens.length < 2) return tokens;
  const at = tokens.findIndex((token) => token.value.split(" ").includes(typeToken));
  if (at === -1 || at === tokens.length - 1) return tokens;
  const trailing = tokens.slice(at + 1);
  if (trailing.some((token) => token.kind !== "word" || isModelDetail(token.value))) return tokens;
  return [...tokens.slice(0, at), ...trailing, tokens[at] as QueryToken];
}

/** Saglayiciya giden slotlar: [deger, ...alternatifler], bas isim sonda. */
export function slotsOf(tokens: readonly QueryToken[]): string[][] {
  return tokens.map((token) => [token.value, ...token.alternatives]);
}
