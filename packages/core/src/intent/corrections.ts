/**
 * Normalizasyon duzeltmesinin niyet katmaninda kabul kurallari (0171 §6.3).
 * Bir duzeltmeden gelen deger ASLA sert filtre (H) olmaz. Siralama ipucu (R)
 * olabilmesi icin HEPSI gerekir; biri eksikse yalnizca gosterim (D) olur ve
 * arayuzde "Sunu mu demek istediniz?" onerisi olarak kalir.
 */
import type { LexiconEntry } from "../search/lexicon.ts";
import { foldForMatch } from "../search/text-match.ts";
import type { CorrectionLike, NormalizedQueryLike } from "./normalized-query-adapter.ts";

/**
 * Varsayilan guven esigi. Kalibrasyonu normalizasyon isinindir (karar 0172);
 * niyet katmani yalnizca parametreyi tanimlar.
 */
export const DEFAULT_CORRECTION_CONFIDENCE_THRESHOLD = 0.9;

export type CorrectionRejection =
  | "low_confidence"
  | "codes_changed"
  | "span_mismatch"
  | "not_canonical";

/** Harf+rakam karisik ya da rakam iceren diziler: "s24", "15", "a54", "rtx4060". */
export function codeTokens(text: string): string[] {
  return (foldForMatch(text).match(/[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/gu) ?? []).sort();
}

function sameCodes(from: string, to: string): boolean {
  const a = codeTokens(from);
  const b = codeTokens(to);
  return a.length === b.length && a.every((code, i) => code === b[i]);
}

function isCanonical(to: string, lexicon: readonly LexiconEntry[]): boolean {
  const target = foldForMatch(to).trim();
  return lexicon.some(
    (entry) =>
      (entry.kind === "brand" || entry.kind === "category" || entry.kind === "synonym") &&
      (foldForMatch(entry.surface) === target || foldForMatch(entry.normalized) === target),
  );
}

export function checkCorrection(
  correction: CorrectionLike,
  query: NormalizedQueryLike,
  lexicon: readonly LexiconEntry[],
  threshold: number = DEFAULT_CORRECTION_CONFIDENCE_THRESHOLD,
): CorrectionRejection | null {
  if (!(correction.confidence >= threshold)) return "low_confidence";
  // Normalizasyonun beyani yetmez: kod kumesi bagimsiz olarak da ayni olmali.
  if (!correction.preservesCodes || !sameCodes(correction.from, correction.to)) {
    return "codes_changed";
  }
  const [start, end] = correction.span;
  const slice = query.raw.slice(start, end);
  if (
    start < 0 ||
    end > query.raw.length ||
    foldForMatch(slice) !== foldForMatch(correction.from)
  ) {
    return "span_mismatch";
  }
  if (!isCanonical(correction.to, lexicon)) return "not_canonical";
  return null;
}
