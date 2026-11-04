/**
 * Kanit eslestirme (0171 §4.1). Bir degerin kaynagini MODEL degil bu modul
 * belirler:
 * - `explicit`: kanit, katlanmis HAM sorguda ardisik token dizisi olarak geciyor;
 * - `corrected`: kanit ham metinde yok, ama normalizasyonun bir duzeltmesinin
 *   (`to`) uzerinden duzeltilmis metinde geciyor;
 * - `inferred`: kanit yok ya da ham sorguyla iliskisi kurulamiyor.
 *
 * Karsilastirma bicimi metin kapisiyla ayni katlamayi kullanir (`foldForMatch`)
 * ve harf/rakam sinirlarini ayirir: "144Hz" ile "144 hz" ayni tokenlara iner.
 */
import { foldForMatch } from "../search/text-match.ts";
import type { CorrectionLike, NormalizedQueryLike } from "./normalized-query-adapter.ts";

export type EvidenceSource = "explicit" | "corrected" | "inferred";

/** Katlanmis, harf/rakam sinirlarindan ayrilmis tokenlar. */
export function evidenceTokens(text: string): string[] {
  return foldForMatch(text)
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** Ardisik alt dizi konumu; yoksa -1. */
export function indexOfSequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export interface EvidenceMatch {
  source: EvidenceSource;
  /** `explicit` ise ham token dizisindeki [baslangic, bitis) araligi. */
  tokenRange: readonly [number, number] | null;
  /** `corrected` ise kullanilan duzeltme(ler). */
  corrections: readonly CorrectionLike[];
}

const INFERRED: EvidenceMatch = { source: "inferred", tokenRange: null, corrections: [] };

export function locateEvidence(
  evidence: string | null | undefined,
  query: NormalizedQueryLike,
): EvidenceMatch {
  if (evidence === null || evidence === undefined) return INFERRED;
  const needle = evidenceTokens(evidence);
  if (needle.length === 0) return INFERRED;

  const raw = evidenceTokens(query.raw);
  const at = indexOfSequence(raw, needle);
  if (at >= 0) {
    return { source: "explicit", tokenRange: [at, at + needle.length], corrections: [] };
  }

  if (query.corrections.length === 0) return INFERRED;
  const corrected = evidenceTokens(query.corrected);
  if (indexOfSequence(corrected, needle) < 0) return INFERRED;
  // Duzeltilmis metinde geciyor: hangi duzeltme(ler) kaniti uretti?
  const used = query.corrections.filter((correction) => {
    const to = evidenceTokens(correction.to);
    return to.length > 0 && indexOfSequence(needle, to) >= 0;
  });
  if (used.length === 0) return INFERRED;
  return { source: "corrected", tokenRange: null, corrections: used };
}

/** Metindeki rakam dizileri ("s24" -> "24", "15 pro max" -> "15"). */
export function numberSet(text: string): Set<string> {
  return new Set(foldForMatch(text).match(/\p{N}+/gu) ?? []);
}

/** `value`deki her sayi kanitta da geciyor mu? Model sayi uydurmasin. */
export function numbersSupported(value: string, evidence: string | null | undefined): boolean {
  const valueNumbers = numberSet(value);
  if (valueNumbers.size === 0) return true;
  if (evidence === null || evidence === undefined) return false;
  const evidenceNumbers = numberSet(evidence);
  for (const n of valueNumbers) if (!evidenceNumbers.has(n)) return false;
  return true;
}

/** Iki metin en az bir anlamli token paylasiyor mu (en az 2 karakter ya da rakam)? */
export function sharesToken(a: string, b: string): boolean {
  const left = new Set(evidenceTokens(a).filter((t) => t.length >= 2 || /\p{N}/u.test(t)));
  return evidenceTokens(b).some((token) => left.has(token));
}

export function rangesOverlap(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
): boolean {
  if (a === null || b === null) return false;
  return a[0] < b[1] && b[0] < a[1];
}
