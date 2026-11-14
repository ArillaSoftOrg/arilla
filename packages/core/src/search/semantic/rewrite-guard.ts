/**
 * Sorgu yeniden yazim (TR -> EN arama terimi) dogrulayicisi (E4-b). Saf fonksiyon; model YOK.
 *
 * Amac: mevcut tek IntentV2/Gemini cagrisinin ileride uretebilecegi Ingilizce arama ifadesi (ya da
 * baska bir ceviri katmani) KULLANICININ HAM METNINE gore denetlenir; anlami degistiren yeniden yazim
 * kullanilmaz, arama ham sorguyla devam eder. Yeniden yazim hicbir zaman kategori ya da ozellik
 * KANITI degildir (karar 0190 kategori kaynagi sozlesmesi): yalniz aday bulma/genisletme icindir.
 *
 * Reddetme kurallari (hepsi deterministik, ham sorgudan):
 * - model/teknik kod (harf+rakam: ddr5, 32gb, bl1830, dcd771) yeniden yazimda AYNEN bulunmali;
 * - olumsuzlanan ozellik (ve sozluk/ozellik esanlamlilari) yeniden yazimda OLUMLU gecmemeli;
 * - ham sorgudaki marka (sozlukte `brand` tipi ya da bilinen marka listesi) korunmali;
 * - ham sorguda olmayan sayi (fiyat, adet, boyut) eklenmemeli;
 * - bos, cok uzun ya da URL/kod iceren cikti kabul edilmez.
 */
import type { LexiconEntry } from "../lexicon.ts";
import { foldForMatch } from "../text-match.ts";
import { negatedTerms, specTokens } from "./hybrid-policy.ts";

export type RewriteRejection =
  | "empty"
  | "too_long"
  | "unsafe_content"
  | "spec_lost"
  | "negation_flipped"
  | "brand_lost"
  | "number_invented";

export interface RewriteVerdict {
  accepted: boolean;
  reason: RewriteRejection | null;
}

const MAX_REWRITE = 120;
const compact = (s: string) => foldForMatch(s).replace(/[\s\-_./]+/g, "");
const numbers = (s: string) => new Set(foldForMatch(s).match(/\d+(?:[.,]\d+)?/g) ?? []);

function containsPhrase(folded: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(folded);
}

/**
 * Olumsuzlanan terimin yeniden yazimda "olmayan/without/non/no" gibi bir olumsuzlukla gecmesi kabul
 * edilir ("wireless olmayan" -> "non-wireless"/"without wireless"); duz olumlu gecis reddedilir.
 */
function negatedPositively(rewriteFolded: string, term: string): boolean {
  if (!containsPhrase(rewriteFolded, term)) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const guarded = new RegExp(`(non|no|not|without|free)[\\s-]+${escaped}|${escaped}[\\s-]*free`);
  return !guarded.test(rewriteFolded);
}

export function verifyRewrite(
  rawQuery: string,
  rewrite: string,
  lexicon: readonly LexiconEntry[],
  brands: readonly string[] = [],
): RewriteVerdict {
  const text = rewrite.trim();
  const reject = (reason: RewriteRejection): RewriteVerdict => ({ accepted: false, reason });
  if (text === "") return reject("empty");
  if (text.length > MAX_REWRITE) return reject("too_long");
  if (/https?:|www\.|[<>{};`]|select\s|drop\s/i.test(text)) return reject("unsafe_content");
  const folded = foldForMatch(text);
  const flat = compact(text);
  for (const spec of specTokens(rawQuery)) if (!flat.includes(spec)) return reject("spec_lost");
  for (const term of negatedTerms(rawQuery, lexicon)) {
    if (negatedPositively(folded, term)) return reject("negation_flipped");
  }
  const rawFolded = foldForMatch(rawQuery);
  for (const brand of brands) {
    const b = foldForMatch(brand);
    if (b && containsPhrase(rawFolded, b) && !containsPhrase(folded, b))
      return reject("brand_lost");
  }
  const allowed = numbers(rawQuery);
  for (const n of numbers(text)) if (!allowed.has(n)) return reject("number_invented");
  return { accepted: true, reason: null };
}
