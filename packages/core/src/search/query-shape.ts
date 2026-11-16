/**
 * Sorgu belirteclerinin sekli (saf, bagimsiz): surum ekleri ve model kodu. `fallback/analyze.ts` ve
 * `text-match.ts` ayni tanimi kullanir (dongusel import olmasin diye ayri dosya).
 */

/** Ayni modelin surum eki ("pro", "max" ...): gevsetmede once birakilir. */
export const VARIANT_WORDS: ReadonlySet<string> = new Set([
  "pro",
  "max",
  "plus",
  "ultra",
  "mini",
  "lite",
  "se",
  "fe",
  "air",
  "xl",
]);

/** Sayi iceren belirtec ("17", "s24", "128gb") ya da surum eki: niteleyici degil, model ayrintisi. */
export function isModelDetail(word: string): boolean {
  return /\d/u.test(word) || VARIANT_WORDS.has(word);
}
