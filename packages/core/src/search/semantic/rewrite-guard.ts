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
  | "language_unsupported"
  | "language_uncertain"
  | "no_rewrite"
  | "price_added"
  | "negation_unresolved"
  | "required_entity_lost"
  | "intent_drift"
  /** Hedef dil sorgu dilinden farkli ama yazim ham sorguyla ayni: ceviri yapilmamis. */
  | "not_translated"
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
/** Sayilar; ondalik ayirici dilden bagimsiz ("15,6" == "15.6"). */
const numbers = (s: string) =>
  new Set((foldForMatch(s).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")));

function containsPhrase(folded: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(folded);
}

/**
 * Olumsuzluk ipuclari VERI tablosu (dil -> katlanmis kelimeler). Yeni dil = tabloya kayit; kod
 * degismez. Tabloda olmayan dilde olumsuzluk yalniz modelin KANITLI dislamalariyla denetlenir.
 */
export const NEGATION_CUE_REGISTRY: Readonly<Record<string, readonly string[]>> = {
  tr: ["olmayan", "olmasin", "olmayanlar", "degil", "haric", "disinda"],
  en: ["without", "no", "not", "non"],
  de: ["ohne", "kein", "keine", "keinen", "keiner", "nicht"],
};

/**
 * Olumsuzlanan terim yazimda gecebilir; ancak cevresinde (en fazla 3 kelime once/sonra) HERHANGI
 * bir dilin olumsuzluk ipucu ya da "-free" eki varsa olumlu sayilmaz ("deri olmayan", "without
 * leather", "ohne Leder", "leather-free"). Ipuclari `NEGATION_CUE_REGISTRY` veri tablosundan gelir.
 */
function negatedPositively(rewriteFolded: string, term: string): boolean {
  if (!containsPhrase(rewriteFolded, term)) return false;
  const tokens = rewriteFolded.split(/[^a-z0-9]+/).filter(Boolean);
  const termTokens = term.split(/[^a-z0-9]+/).filter(Boolean);
  const cues = new Set([...Object.values(NEGATION_CUE_REGISTRY).flat(), "free"]);
  for (let i = 0; i + termTokens.length <= tokens.length; i++) {
    if (termTokens.some((t, j) => tokens[i + j] !== t)) continue;
    const window = [
      ...tokens.slice(Math.max(0, i - 3), i),
      ...tokens.slice(i + termTokens.length, i + termTokens.length + 3),
    ];
    if (!window.some((w) => cues.has(w))) return true;
  }
  return false;
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

// --- dil bagimsiz sozlesme (E4b C+) ---------------------------------------------------------

/** Para birimi ve fiyat ifadeleri: yazim fiyat EKLEYEMEZ (butce IntentV2 alanidir). Veri tablosu. */
export const PRICE_TERM_REGISTRY: Readonly<Record<string, readonly string[]>> = {
  any: ["tl", "try", "usd", "eur", "euro", "lira", "dollar", "dollars"],
  tr: ["ucuz", "alti", "kadar", "butce"],
  en: ["under", "below", "cheap", "cheaper", "budget"],
  de: ["unter", "billig", "gunstig", "guenstig"],
};

const words = (folded: string) => new Set(folded.split(/[^a-z0-9]+/).filter(Boolean));
const anyWord = (set: Set<string>, list: readonly string[]) => list.some((w) => set.has(w));
const allCues = () => Object.values(NEGATION_CUE_REGISTRY).flat();
const allPriceTerms = () => Object.values(PRICE_TERM_REGISTRY).flat();

/**
 * Capraz dil kosinusu ZAYIF bir sinyaldir: kisa/nadir sozcuklerde dogru ceviriler de dusuk kalir
 * (E4b olcumu: "sourdough jar" 0,397, "dumpling mold" 0,411). Yalniz bariz kaymayi eler.
 * 0,35 E4b C+ kosusunun verisine bakilarak secildi (sonradan ayar); bagimsiz veride dogrulanmali.
 */
export const DEFAULT_MIN_CROSS_LINGUAL_COSINE = 0.35;

export interface CanonicalContext {
  lexicon: readonly LexiconEntry[];
  /** "any" (varsayilan): her dil; yalniz `und`/dusuk guven geri duser. */
  acceptedQueryLanguages?: readonly string[] | "any";
  /**
   * Dilden bagimsiz OZEL ADLAR (marka); ham metinde geciyorsa yazimda birebir korunmali.
   * Cevrilebilen siradan sozcukler (uyumlu cihaz turu: "puset", "Kinderwagen") buraya KONMAZ;
   * model kodlari ve kapasiteler zaten teknik kod kuraliyla korunur.
   */
  requiredEntities: readonly string[];
  /** Ham sorgu ile yazimin capraz dil kosinusu (BGE-M3); verilmezse kayma denetlenmez. */
  crossLingualCosine?: number | null;
  minCrossLingualCosine?: number;
}

export interface CanonicalVerdict extends RewriteVerdict {
  /** Kaniti ham metinde dogrulanan dislanmis ozellikler (katlanmis). */
  verifiedExcluded: string[];
  /** Olumsuzluk denetimi: ipucu tablosuyla mi, yalniz model dislamasiyla mi yapildi. */
  negationCheck: "cue_table" | "model_evidence_only";
}

export function verifyCanonicalQuery(
  rawQuery: string,
  detected: { tag: string; confidence: string },
  rewrite: { language: string; text: string } | null,
  excluded: readonly { text: string; evidence: string | null }[],
  ctx: CanonicalContext,
): CanonicalVerdict {
  const rawFolded = foldForMatch(rawQuery);
  const primary = (detected.tag.toLowerCase().split("-")[0] ?? "").trim();
  const negationCheck: CanonicalVerdict["negationCheck"] =
    primary in NEGATION_CUE_REGISTRY ? "cue_table" : "model_evidence_only";
  const verifiedExcluded = excluded
    .filter((f) => f.evidence && rawFolded.includes(foldForMatch(f.evidence)))
    .map((f) => foldForMatch(f.text))
    .filter((t) => t.length > 1);
  const out = (reason: RewriteRejection | null): CanonicalVerdict => ({
    accepted: reason === null,
    reason,
    verifiedExcluded,
    negationCheck,
  });
  const accepted = ctx.acceptedQueryLanguages ?? "any";
  if (!primary || primary === "und") return out("language_uncertain");
  if (accepted !== "any" && !accepted.includes(primary)) return out("language_unsupported");
  if (detected.confidence === "low") return out("language_uncertain");
  const text = rewrite?.text?.trim() ?? "";
  if (!text) return out("no_rewrite");
  const target = (rewrite?.language.toLowerCase().split("-")[0] ?? "").trim();
  if (target && target !== primary && foldForMatch(text) === rawFolded)
    return out("not_translated");
  const base = verifyRewrite(rawQuery, text, ctx.lexicon, []);
  if (!base.accepted) return out(base.reason);
  const folded = foldForMatch(text);
  const rawWords = words(rawFolded);
  const outWords = words(folded);
  if (anyWord(outWords, allPriceTerms()) && !anyWord(rawWords, allPriceTerms())) {
    return out("price_added");
  }
  for (const term of verifiedExcluded) {
    if (negatedPositively(folded, term)) return out("negation_flipped");
  }
  // Ham metinde (ipucu tablosundaki herhangi bir dilde) olumsuzluk var; ne kanitli dislama ne de
  // yazimda olumsuzluk ifadesi yok: anlam kaybolmus olabilir -> ham sorgu korunur.
  if (
    anyWord(rawWords, allCues()) &&
    verifiedExcluded.length === 0 &&
    !anyWord(outWords, allCues())
  ) {
    return out("negation_unresolved");
  }
  for (const entity of ctx.requiredEntities) {
    const e = foldForMatch(entity);
    if (e && containsPhrase(rawFolded, e) && !containsPhrase(folded, e)) {
      return out("required_entity_lost");
    }
  }
  const min = ctx.minCrossLingualCosine ?? DEFAULT_MIN_CROSS_LINGUAL_COSINE;
  if (ctx.crossLingualCosine != null && ctx.crossLingualCosine < min) return out("intent_drift");
  return out(null);
}
