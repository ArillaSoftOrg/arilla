/**
 * Sozluge bagli yazim duzeltici (karar 0172). Saf, deterministik; DB/ag/model yok.
 *
 * Token basina karar sirasi:
 *   1. Korunan token (rakamli kod, birim, surum eki, olumsuzluk/fiyat/islev kelimesi,
 *      tirnak ici, <= 2 harf) -> dokunulmaz.
 *   2. Dagarcikta birebir (katlanmis) var:
 *      yazildigi bicim gorunen bicimlerden biriyse dokunulmaz; degilse Turkce karakter
 *      geri kazanimi ("kilif" -> "kılıf", "pedı" -> "pedi").
 *   3. Bilinen kok + gecerli ek (unlu uyumlu) -> bilinen kelimedir; gerekirse yalniz karakter
 *      geri kazanimi.
 *   4. Aday arama: fonetik anahtar kovasi + ilk harf/uzunluk kovasi; Damerau mesafesi ve
 *      fonetik bicim mesafesi; ekli kelimede kok uzerinden ("koruycusu" -> "koruyucusu").
 *      Siklik ve komsu kelimeyle bilinen ikili ("sarj aleti") oncelik verir. Iki aday
 *      yakinsa belirsizdir: guven duser, en fazla 2 alternatif doner.
 *
 * Normalizasyon anlam degistirmez; yalniz yazim duzeltir. Rol/tur karari niyet katmanindadir.
 */

import { UNIT_WORDS, VARIANT_WORDS } from "../fallback/analyze.ts";
import { editDistance } from "../fallback/grade.ts";
import type {
  Correction,
  CorrectionAlternative,
  CorrectionEvidence,
  CorrectionKind,
  NormalizedToken,
  VocabularySource,
} from "../normalized-query.ts";
import { foldForMatch } from "../text-match.ts";
import { phoneticForm, phoneticKey } from "./phonetic.ts";
import { renderSuffixed, suffixSplits } from "./suffixes.ts";
import { dominantDisplay, type Vocabulary, type VocabularyWord } from "./vocabulary.ts";

/** Bu guvenin altindaki duzeltme uretilmez (gelistirme kumesinde kalibre). */
export const MIN_CONFIDENCE = 0.6;

/** En iyi iki adayin skor farki bunun altindaysa belirsiz. */
const AMBIGUITY_GAP = 0.35;

/**
 * Asla duzeltilmeyen islev kelimeleri: olumsuzluk, fiyat, iliski ve konusma dolgusu
 * (katlanmis). Yanlis "duzeltme" filtrenin anlamini tersine cevirir.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "olmasin",
  "olmayan",
  "haric",
  "degil",
  "disinda",
  "tarzi",
  "gibi",
  "tl",
  "try",
  "lira",
  "bin",
  "milyon",
  "alti",
  "altinda",
  "ustu",
  "uzeri",
  "kadar",
  "arasi",
  "icin",
  "ile",
  "uyumlu",
  "ve",
  "veya",
  "ya",
  "en",
  "iyi",
  "cok",
  "az",
  "yeni",
  "ariyorum",
  "istiyorum",
  "bakiyorum",
  "lazim",
  "bana",
  "bir",
  "lutfen",
]);

const WORD_RE = /[\p{L}\p{N}]+/gu;
const DIGIT_RE = /\d/;

interface RawToken {
  text: string;
  lower: string;
  folded: string;
  start: number;
  end: number;
}

function tokenize(raw: string): RawToken[] {
  const out: RawToken[] = [];
  for (const match of raw.matchAll(WORD_RE)) {
    const text = match[0];
    const lower = text.toLocaleLowerCase("tr-TR");
    out.push({
      text,
      lower,
      folded: foldForMatch(lower),
      start: match.index,
      end: match.index + text.length,
    });
  }
  return out;
}

/** Tirnak icindeki karakter araliklari (kullanici "aynen bunu" demis). */
function quotedRanges(raw: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of raw.matchAll(/["“”«»]([^"“”«»]*)["“”«»]/gu)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function isProtected(
  token: RawToken,
  previous: RawToken | undefined,
  quoted: [number, number][],
): boolean {
  if (DIGIT_RE.test(token.folded)) return true;
  if (token.folded.length <= 2) return true;
  if (VARIANT_WORDS.has(token.folded)) return true;
  if (FUNCTION_WORDS.has(token.folded)) return true;
  if (UNIT_WORDS.has(token.folded) && previous && /^\d+$/.test(previous.folded)) return true;
  return quoted.some(([start, end]) => token.start >= start && token.end <= end);
}

/** Rakamli/alfanumerik dizilerin kumesi; `preservesCodes` garantisi. */
function codes(text: string): string {
  return [...(foldForMatch(text).match(/[\p{L}\p{N}]*\d[\p{L}\p{N}]*/gu) ?? [])].sort().join(" ");
}

const SOURCE_PRIORITY: readonly VocabularySource[] = ["brand", "category", "lexicon", "seed"];

function primarySource(word: VocabularyWord): VocabularySource {
  return SOURCE_PRIORITY.find((source) => word.sources.has(source)) ?? "lexicon";
}

function kindOf(word: VocabularyWord): CorrectionKind {
  return word.sources.has("brand") && !word.sources.has("category") ? "brand" : "spelling";
}

const FOLDED_VOWEL = /[aeiou]/g;

/**
 * Katlanmis unlu uyumu: ekin ilk unlusu kokun son unlusuyle uyumlu mu. Yalnizca
 * katlamada ayirt edilebilen durumlar denetlenir (i/u ust unlu; a/e kok a/e ise).
 * "son"+"i" (soni) reddedilir; "ped"+"i", "kulaklig"+"i", "pil"+"leri" kabul.
 */
function harmonizes(stem: string, suffix: string): boolean {
  const stemVowels = stem.match(FOLDED_VOWEL);
  const suffixVowel = suffix.match(FOLDED_VOWEL)?.[0];
  if (!stemVowels || !suffixVowel) return true;
  const last = stemVowels[stemVowels.length - 1] as string;
  if (suffixVowel === "i") return last === "a" || last === "e" || last === "i";
  if (suffixVowel === "u") return last === "o" || last === "u";
  if (last === "a") return suffixVowel === "a";
  if (last === "e") return suffixVowel === "e";
  return true;
}

function maxEdit(length: number): number {
  if (length <= 3) return 0;
  if (length <= 5) return 1;
  return 2;
}

interface Candidate {
  word: VocabularyWord;
  /** Gorunen hedef (ekli olabilir). */
  display: string;
  cost: number;
  score: number;
  method: CorrectionEvidence["method"];
  distance: number;
  bigram: boolean;
}

interface Context {
  left: string | undefined;
  right: string | undefined;
}

function frequencyPrior(word: VocabularyWord): number {
  return 0.15 * Math.log10(1 + word.count);
}

/**
 * Fonetik (kulaga gore) esdegerlik yabanci kokenli hedefler icindir: marka, tohum, lexicon
 * (TR <-> EN urun kelimeleri) ya da Turkce yaziminda olmayan harf dizisi. Yalniz Turkce
 * kategori adindan gelen kelimeye fonetik indirim uygulanmaz ("zılama" -> "sulama" olmaz).
 */
function foreignEligible(word: VocabularyWord): boolean {
  return !categoryOnly(word) || foreignOrthography(word.folded);
}

/** Bir katlanmis kelime icin dagarciktan duzeltme adaylari (eki olmayan bicim). */
function stemCandidates(
  folded: string,
  vocabulary: Vocabulary,
): Map<VocabularyWord, { d: number; pf: number; keyEq: boolean }> {
  const out = new Map<VocabularyWord, { d: number; pf: number; keyEq: boolean }>();
  const length = folded.length;
  const limit = maxEdit(length);
  const key = phoneticKey(folded);
  const form = phoneticForm(folded);
  const consider = (word: VocabularyWord) => {
    if (out.has(word) || word.folded === folded) return;
    const keyEq = word.key === key;
    const d = editDistance(folded, word.folded, 3);
    const pf = editDistance(form, word.form, 3);
    const phoneticLimit = length <= 5 ? 1 : 2;
    const phonetic = foreignEligible(word);
    const ok =
      d <= limit || (phonetic && ((keyEq && pf <= phoneticLimit) || (length >= 5 && pf <= 1)));
    if (ok)
      out.set(
        word,
        phonetic ? { d, pf, keyEq } : { d, pf: Number.POSITIVE_INFINITY, keyEq: false },
      );
  };
  for (const word of vocabulary.byKey(key)) consider(word);
  if (limit > 0) {
    const first = folded[0] as string;
    for (let len = length - limit; len <= length + limit; len += 1) {
      for (const word of vocabulary.byBucket(first, len)) consider(word);
    }
    const formFirst = form[0] as string;
    for (let len = form.length - 1; len <= form.length + 1; len += 1) {
      for (const word of vocabulary.byPhoneticBucket(formFirst, len)) consider(word);
    }
  }
  return out;
}

function costOf(match: { d: number; pf: number; keyEq: boolean }): {
  cost: number;
  method: CorrectionEvidence["method"];
} {
  // Ayni iskelet (unsuzler ayni): fonetik yazimin en sik farki unlulerdir, ucuz sayilir.
  const phonetic = match.keyEq ? 0.25 + 0.4 * match.pf : match.pf + 0.5;
  if (!Number.isFinite(phonetic)) return { cost: match.d, method: "edit" };
  if (phonetic < match.d) return { cost: phonetic, method: "phonetic" };
  return { cost: match.d, method: "edit" };
}

function bigramWith(folded: string, context: Context, vocabulary: Vocabulary): boolean {
  return (
    (context.left !== undefined && vocabulary.hasBigram(context.left, folded)) ||
    (context.right !== undefined && vocabulary.hasBigram(folded, context.right))
  );
}

function candidatesFor(token: RawToken, context: Context, vocabulary: Vocabulary): Candidate[] {
  const out: Candidate[] = [];
  const push = (
    word: VocabularyWord,
    display: string,
    cost: number,
    method: Candidate["method"],
    distance: number,
    bigramKey: string,
  ) => {
    const bigram = bigramWith(bigramKey, context, vocabulary);
    const score = -cost + frequencyPrior(word) + (bigram ? 0.6 : 0);
    out.push({ word, display, cost, score, method, distance, bigram });
  };

  for (const [word, match] of stemCandidates(token.folded, vocabulary)) {
    const display = dominantDisplay(word);
    if (display === null) continue;
    const { cost, method } = costOf(match);
    push(word, display, cost, method, match.d, word.folded);
  }

  // Ekli kelime: kok uzerinden aday ("koruycusu" -> "koruyucu" + "su"). Yalniz butun kelime
  // yolu iyi bir aday bulamadiysa; kok en az 5 harf, ek en az 2 harf, kok duzeltmesi tek harf.
  const wholeBest = out.reduce(
    (min, candidate) => Math.min(min, candidate.cost),
    Number.POSITIVE_INFINITY,
  );
  if (wholeBest > 1) {
    for (const split of suffixSplits(token.folded)) {
      if (split.stem.length < 5 || split.suffix.length < 2 || vocabulary.get(split.stem)) continue;
      for (const [word, match] of stemCandidates(split.stem, vocabulary)) {
        if (match.d > 1 || !harmonizes(word.folded, split.suffix)) continue;
        const stemDisplay = dominantDisplay(word);
        if (stemDisplay === null) continue;
        const display = renderSuffixed(stemDisplay, split.suffix, split.softened);
        push(word, display, match.d + 0.25, "suffix", match.d, word.folded);
      }
    }
  }

  // Ayni hedefe giden en iyi yol kalir.
  const best = new Map<string, Candidate>();
  for (const candidate of out) {
    const current = best.get(candidate.display);
    if (!current || candidate.score > current.score) best.set(candidate.display, candidate);
  }
  return [...best.values()].sort(
    (a, b) => b.score - a.score || a.display.localeCompare(b.display, "tr"),
  );
}

function confidenceOf(candidate: Candidate, length: number): number {
  let confidence: number;
  if (candidate.cost <= 0.25) confidence = 0.92;
  else if (candidate.cost <= 1) confidence = 0.82;
  else if (candidate.cost <= 1.5) confidence = 0.72;
  else if (candidate.cost <= 2) confidence = 0.62;
  else confidence = 0.5;
  if (length <= 4 && candidate.cost >= 1) confidence -= 0.1;
  if (candidate.bigram) confidence += 0.05;
  return Math.max(0, Math.min(0.99, confidence));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const TURKISH_LETTERS = /[çğıöşü]/;

/**
 * Karakter geri kazanimi yalniz Turkce harf EKLER ya da ı/i karisikligini duzeltir: kullanicinin
 * bilerek yazdigi Turkce harf silinmez ("kaşkılık" -> "kaskılık" olmaz). Istisna: marka
 * ("asüs" -> "asus").
 */
function restorationAllowed(rawLower: string, display: string, brandTarget: boolean): boolean {
  if (brandTarget) return true;
  if (rawLower.length !== display.length) return false;
  for (let i = 0; i < rawLower.length; i += 1) {
    const from = rawLower[i] as string;
    const to = display[i] as string;
    if (from === to) continue;
    if ((from === "ı" && to === "i") || (from === "i" && to === "ı")) continue;
    if (TURKISH_LETTERS.test(from)) return false;
  }
  return true;
}

/** Bilinen kelime (birebir ya da bilinen kok + uyumlu ek) icin olasi karakter geri kazanimi. */
function knownWordCorrection(
  token: RawToken,
  vocabulary: Vocabulary,
): { known: boolean; correction?: Omit<Correction, "span" | "from"> } {
  const exact = vocabulary.get(token.folded);
  if (exact) {
    if (exact.displays.has(token.lower)) return { known: true };
    const display = dominantDisplay(exact);
    if (display === null || display === token.lower) return { known: true };
    if (!restorationAllowed(token.lower, display, kindOf(exact) === "brand"))
      return { known: true };
    return {
      known: true,
      correction: {
        to: display,
        kind: kindOf(exact),
        confidence: 0.95,
        preservesCodes: true,
        evidence: { method: "lexicon", source: primarySource(exact), distance: 0 },
      },
    };
  }
  for (const split of suffixSplits(token.folded)) {
    const stem = vocabulary.get(split.stem);
    if (!stem || !harmonizes(split.stem, split.suffix)) continue;
    const stemDisplay = dominantDisplay(stem);
    // Uc harfli kok + tek harfli ek ("kis"+"a") cok anlamlidir: bilinen say, karakter ekleme.
    if (stemDisplay === null || (split.stem.length <= 3 && split.suffix.length === 1)) {
      return { known: true };
    }
    const rendered = renderSuffixed(stemDisplay, split.suffix, split.softened);
    if (rendered === token.lower || foldForMatch(rendered) !== token.folded) return { known: true };
    if (!restorationAllowed(token.lower, rendered, kindOf(stem) === "brand"))
      return { known: true };
    return {
      known: true,
      correction: {
        to: rendered,
        kind: kindOf(stem),
        confidence: 0.9,
        preservesCodes: true,
        evidence: { method: "suffix", source: primarySource(stem), distance: 0 },
      },
    };
  }
  // Dagarcikta yalniz ekli bicimi olan kok ("stand" <- "standı", "ped" <- "pedi"): kelime
  // gecerli bir koktur; ekli bicime "duzeltilmez".
  if (token.folded.length >= 4 && hasInflectedForm(token.folded, vocabulary))
    return { known: true };
  return { known: false };
}

/** Kelimeye uyumlu bir ek eklenmis bicim dagarcikta var mi. */
function hasInflectedForm(folded: string, vocabulary: Vocabulary): boolean {
  for (const suffix of ["i", "u", "si", "su", "lari", "leri", "lar", "ler"]) {
    if (!harmonizes(folded, suffix)) continue;
    const joined =
      /[aeiou]$/.test(folded) && /^[iu]$/.test(suffix)
        ? `${folded}s${suffix}`
        : `${folded}${suffix}`;
    if (vocabulary.get(joined)) return true;
  }
  return false;
}

/**
 * Turkce yaziminda olmayan harf/dizi (q, w, x, ph, th, sh, ck, oo, ee) tasiyan kelime
 * yabanci (cogunlukla ingilizce urun) kelimesidir: yalniz Turkce kategori adindan gelen bir
 * kelimeye "duzeltilmez" ("phone" -> "fona" olmaz).
 */
function foreignOrthography(folded: string): boolean {
  return /[qwx]|ph|th|sh|ck|oo|ee/.test(folded);
}

function categoryOnly(word: VocabularyWord): boolean {
  return word.sources.size === 1 && word.sources.has("category");
}

export interface CorrectionResult {
  tokens: NormalizedToken[];
  corrections: Correction[];
  corrected: string;
}

/** Ham sorgu -> tokenlar, duzeltmeler ve duzeltilmis metin. */
export function correctQuery(raw: string, vocabulary: Vocabulary): CorrectionResult {
  const tokens = tokenize(raw);
  const quoted = quotedRanges(raw);
  const corrections: Correction[] = [];

  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    if (isProtected(token, previous, quoted)) return;
    const span: [number, number] = [token.start, token.end];

    const known = knownWordCorrection(token, vocabulary);
    if (known.known) {
      if (known.correction) corrections.push({ from: token.text, span, ...known.correction });
      return;
    }

    // Uc harf ve kisasi: yazim hatasi ile baska bir gecerli kelime ayirt edilemez.
    if (token.folded.length <= 3) return;
    const context: Context = { left: previous?.folded, right: tokens[index + 1]?.folded };
    const foreign = foreignOrthography(token.folded);
    const ranked = candidatesFor(token, context, vocabulary).filter(
      (candidate) => !(foreign && categoryOnly(candidate.word)),
    );
    const best = ranked[0];
    if (!best) return;
    let confidence = confidenceOf(best, token.folded.length);
    const others = ranked.slice(1).filter((other) => best.score - other.score < AMBIGUITY_GAP);
    if (others.length > 0) confidence -= 0.15;
    if (confidence < MIN_CONFIDENCE) return;
    if (codes(token.text) !== codes(best.display)) return;

    const alternatives: CorrectionAlternative[] = others.slice(0, 2).map((other) => ({
      to: other.display,
      confidence: round(Math.max(0, confidenceOf(other, token.folded.length) - 0.15)),
    }));
    corrections.push({
      from: token.text,
      to: best.display,
      span,
      kind: kindOf(best.word),
      confidence: round(confidence),
      preservesCodes: true,
      ...(alternatives.length > 0 ? { alternatives } : {}),
      evidence: { method: best.method, source: primarySource(best.word), distance: best.distance },
    });
  });

  let corrected = raw;
  for (const correction of [...corrections].sort((a, b) => b.span[0] - a.span[0])) {
    corrected = `${corrected.slice(0, correction.span[0])}${correction.to}${corrected.slice(correction.span[1])}`;
  }

  return {
    tokens: tokens.map((token, index) => {
      const next = tokens[index + 1];
      const unitToken =
        /^\d+$/.test(token.folded) && next && UNIT_WORDS.has(next.folded) ? next.folded : null;
      const glued = token.folded.match(/^(\d+(?:[.,]\d+)?)([a-z]+)$/);
      const unit = unitToken
        ? { value: Number(token.folded), unit: unitToken }
        : glued && UNIT_WORDS.has(glued[2] as string)
          ? { value: Number((glued[1] as string).replace(",", ".")), unit: glued[2] as string }
          : undefined;
      return {
        text: token.text,
        span: [token.start, token.end] as const,
        ...(unit ? { unit } : {}),
      };
    }),
    corrections,
    corrected,
  };
}
