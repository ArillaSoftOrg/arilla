/**
 * Aday dogrulama ve alaka puani. Saglayiciya DEGIL, donen urunlere uygulanir:
 * SQL kapisi (trigram) ya da ileride OpenSearch ne dondururse, "bu gercekten
 * aranan mi, yakin mi, alakasiz mi" karari burada, ayni kuralla verilir.
 *
 * Neden gerekli: SQL kapisi 3+ tokenli sorguda bir niteleyici eksige izin
 * verir. "iphone 17 pro max" icin "iPhone 16 Pro Max" kapidan gecer ve
 * kullaniciya GERCEK sonucmus gibi gosterilirdi. Burada model numarasi sert
 * kisit olarak okunur: tutmayan urun `exact` olamaz.
 *
 * Saf fonksiyon: DB, ag, model yok.
 */
import type { SearchResultItem } from "../result-types.ts";
import { foldForMatch } from "../text-match.ts";
import { type QueryToken, VARIANT_WORDS, wordsOf } from "./analyze.ts";
import type { MatchTier } from "./types.ts";

/** Token turune gore agirlik: model kodu en belirleyici. */
const WEIGHT: Record<QueryToken["kind"], number> = { model: 2, variant: 1.5, word: 1 };
/** Turkce isim tamlamasi ve "iphone 17" gibi aileler: bas token biraz daha agir. */
const HEAD_BONUS = 0.5;

/** Kismi token eslesmesinin puani. */
const SIM_EXACT = 1;
const SIM_PREFIX = 0.9;
const SIM_FUZZY_1 = 0.8;
const SIM_FUZZY_2 = 0.7;

/** Birlesik skorun alti alakasiz sayilir. */
export const MIN_RELATED_SCORE = 0.35;
/** `close` icin alt sinir. */
const MIN_CLOSE_COVERAGE = 0.5;
/** Model kodu celiskili urunun puan carpani. */
const MODEL_MISMATCH_FACTOR = 0.6;
/** Sorguda olmayan her ek surum eki ("max") puani bu kadar dusurur. */
const EXTRA_VARIANT_PENALTY = 0.06;

/** Iki dizge arasi Damerau-Levenshtein (bitisik yer degistirme dahil). */
export function editDistance(a: string, b: string, limit = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) (d[i] as number[])[0] = i;
  for (let j = 0; j < cols; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        ((d[i - 1] as number[])[j] as number) + 1,
        ((d[i] as number[])[j - 1] as number) + 1,
        ((d[i - 1] as number[])[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      (d[i] as number[])[j] = best;
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * Tek bir sorgu sozcugunun urun sozcuklerine karsi en iyi benzerligi (0 = yok).
 * Model kodlari yalnizca birebir; kelimeler onek/ek ve kucuk yazim hatasi
 * toleransiyla ("airpod" ~ "airpods", "ayakkabisi" ~ "ayakkabi", "iphne").
 */
export function wordSimilarity(
  word: string,
  docWords: readonly string[],
  kind: QueryToken["kind"],
): number {
  let best = 0;
  for (const doc of docWords) {
    if (doc === word) return SIM_EXACT;
    if (kind === "model") continue;
    if (kind === "variant") continue;
    if (word.length >= 3 && doc.length >= 3) {
      const [shorter, longer] = word.length <= doc.length ? [word, doc] : [doc, word];
      if (
        longer.startsWith(shorter) &&
        longer.length - shorter.length <= 3 &&
        shorter.length >= 4
      ) {
        best = Math.max(best, SIM_PREFIX);
        continue;
      }
    }
    if (word.length >= 5 && doc.length >= 4) {
      const distance = editDistance(word, doc, 2);
      if (distance === 1) best = Math.max(best, SIM_FUZZY_1);
      else if (distance === 2 && word.length >= 8) best = Math.max(best, SIM_FUZZY_2);
    }
  }
  return best;
}

export interface TokenMatch {
  token: QueryToken;
  similarity: number;
}

export interface GradeResult {
  tier: MatchTier | "none";
  /** 0..1, ek surum cezasi dahil. */
  score: number;
  missing: string[];
  /** Sorgudaki bir model kodu (orn. "17") urunde yok. */
  modelMismatch: boolean;
  /** Bir token yalnizca bulanik/onek ile eslesti. */
  approximate: boolean;
}

function tokenSimilarity(token: QueryToken, docWords: readonly string[]): number {
  const candidates = [token.value, ...token.alternatives];
  let best = 0;
  for (const candidate of candidates) {
    // Cok kelimeli es anlamli: tum kelimeler eslesmeli, en zayifi sayilir.
    const parts = candidate.split(" ");
    let phrase = 1;
    for (const part of parts) {
      phrase = Math.min(phrase, wordSimilarity(part, docWords, token.kind));
      if (phrase === 0) break;
    }
    best = Math.max(best, phrase);
  }
  return best;
}

export function documentWords(item: Pick<SearchResultItem, "title" | "brandName">): string[] {
  return wordsOf(`${item.title} ${item.brandName ?? ""}`);
}

/** Dedupe anahtari: ayni marka + ayni katlanmis baslik ayni urundur. */
export function canonicalKey(item: Pick<SearchResultItem, "title" | "brandName">): string {
  return `${foldForMatch(item.brandName ?? "")}|${wordsOf(item.title).join(" ")}`;
}

/**
 * `tokens` bos ise (sorgu tamamen filtreye cevrildi) metin acisindan her urun
 * `exact`tir; kisit gevsetmesinin kapak etkisi pipeline'da uygulanir.
 */
export function gradeItem(
  tokens: readonly QueryToken[],
  item: Pick<SearchResultItem, "title" | "brandName">,
): GradeResult {
  if (tokens.length === 0) {
    return { tier: "exact", score: 1, missing: [], modelMismatch: false, approximate: false };
  }
  const docWords = documentWords(item);

  let total = 0;
  let matched = 0;
  const missing: string[] = [];
  let modelMismatch = false;
  let approximate = false;
  let anchorMatched = false;
  let hasAnchorToken = false;

  tokens.forEach((token, index) => {
    const weight = WEIGHT[token.kind] + (index === tokens.length - 1 ? HEAD_BONUS : 0);
    const similarity = tokenSimilarity(token, docWords);
    total += weight;
    matched += weight * similarity;
    const isAnchor = token.kind === "word" ? token.value.length >= 3 : token.kind === "model";
    if (isAnchor) hasAnchorToken = true;
    if (similarity === 0) {
      missing.push(token.value);
      if (token.kind === "model") modelMismatch = true;
    } else {
      if (similarity < SIM_PREFIX) approximate = true;
      if (isAnchor) anchorMatched = true;
    }
  });

  const coverage = total === 0 ? 0 : matched / total;

  // Urunde sorguda olmayan ek surum eki: "iphone 17 pro" -> "17 Pro Max" biraz geride.
  const queryWords = new Set(tokens.flatMap((token) => [token.value, ...token.alternatives]));
  const extraVariants = docWords.filter(
    (word) => VARIANT_WORDS.has(word) && !queryWords.has(word),
  ).length;
  // Model kodu tutmayan urun ("16" aranirken "17"), ayni kodu tasiyan komsulardan
  // hep geride kalir: kisi once ayni nesli gormek ister.
  const base = Math.max(0, coverage - extraVariants * EXTRA_VARIANT_PENALTY);
  const score = modelMismatch ? base * MODEL_MISMATCH_FACTOR : base;

  let tier: GradeResult["tier"];
  if (missing.length === 0) tier = "exact";
  else if (hasAnchorToken && !anchorMatched) tier = "none";
  else if (modelMismatch) tier = coverage >= MIN_RELATED_SCORE ? "related" : "none";
  else
    tier =
      coverage >= MIN_CLOSE_COVERAGE ? "close" : coverage >= MIN_RELATED_SCORE ? "related" : "none";

  return { tier, score, missing, modelMismatch, approximate };
}
