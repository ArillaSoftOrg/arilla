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
import { ATTRIBUTE_VALUES, oppositeOf } from "../../intent/antonyms.ts";
import type { LexiconEntry } from "../lexicon.ts";
import { foldForMatch } from "../text-match.ts";
import { looksLikeAccessory, queryWantsAccessory } from "./accessory-guard.ts";
import { negatedTerms, specTokens } from "./hybrid-policy.ts";

export type RewriteRejection =
  /** Dogrulanmis yorum dusuk guvenli ya da dusurulmus: genisletme yapilmaz. */
  | "interpretation_uncertain"
  /** Ham metinde kaniti olan (explicit) urun turu yok: yazim bir urun turu UYDURABILIR (E4b Q66). */
  | "product_type_unverified"
  /** Sorguyla AYNI dildeki yazim, dogrulanmis urun turunun bas ismini tasimiyor. */
  | "type_anchor_lost"
  /** Kullanici ana urun istiyor; yazim aksesuar/yedek parca gibi. */
  | "role_changed"
  /** Ham sorgudaki sayi+birim yazimda ayni sayi ve ayni birim ailesiyle yok. */
  | "unit_changed"
  /** Yazimda ham sorguda olmayan bilinen marka var. */
  | "brand_invented"
  /** Yazimda ham sorguda (ya da kanitli yorumda) olmayan kapali ozellik var. */
  | "attribute_invented"
  /** Ayni cagrinin baska bir yazimi yorum duzeyinde reddedildi: hicbiri kullanilmaz. */
  | "set_inconsistent"
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

/**
 * Sayi+birim aileleri VERI tablosu (katlanmis yuzeyler). Ham sorguda "125 ml", "1TB", "15,6 inc",
 * "Grosse 2" gibi bir sayi+birim varsa yazimda AYNI sayi ve AYNI ailedeki bir birim bulunmali.
 * Yeni dil/birim = tabloya kayit. Tabloda olmayan birim denetlenmez (sayi kurali yine gecerli).
 */
export const UNIT_REGISTRY: readonly (readonly string[])[] = [
  ["ml", "mililitre", "milliliter", "millilitre"],
  ["l", "lt", "litre", "liter", "liters", "litres"],
  ["mb", "megabyte"],
  ["gb", "gigabyte", "gigabayt"],
  ["tb", "terabyte", "terabayt"],
  ["inc", "inch", "inches", "zoll"],
  ["mm", "milimetre", "millimeter"],
  ["cm", "santim", "santimetre", "centimeter", "zentimeter"],
  ["kg", "kilo", "kilogram"],
  ["g", "gr", "gram"],
  ["v", "volt"],
  ["w", "watt"],
  ["mah"],
  ["hz"],
  ["ay", "aylik", "month", "months", "monat", "monate"],
  ["numara", "size", "beden", "grosse", "groesse"],
];

const UNIT_INDEX = new Map<string, number>();
UNIT_REGISTRY.forEach((group, i) => {
  for (const u of group) if (!UNIT_INDEX.has(u)) UNIT_INDEX.set(u, i);
});

/** Katlanmis metindeki (sayi, birim ailesi) ciftleri: "125 ml", "1tb", "size 2" (birim once). */
function numberUnits(folded: string): { n: string; family: number }[] {
  const out: { n: string; family: number }[] = [];
  for (const m of folded.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-z]+)/g)) {
    const family = UNIT_INDEX.get(m[2] ?? "");
    if (family !== undefined) out.push({ n: (m[1] ?? "").replace(",", "."), family });
  }
  for (const m of folded.matchAll(/\b([a-z]+)\s+(\d+(?:[.,]\d+)?)\b/g)) {
    const family = UNIT_INDEX.get(m[1] ?? "");
    // Yalniz birimi sayidan ONCE yazilan aileler (beden/numara/size).
    if (family !== undefined && UNIT_REGISTRY[family]?.includes("size")) {
      out.push({ n: (m[2] ?? "").replace(",", "."), family });
    }
  }
  return out;
}

/**
 * Dogrulanmis IntentV2 yorumundan (validate.ts) gelen KANIT durumu. Model ciktisi degil, dogrulayicinin
 * ham metne karsi denetledigi sonuctur: `source: "explicit"` = degerin kaniti ham metinde var.
 */
export interface InterpretationEvidence {
  productType: { value: string; source: string } | null;
  role: string | null;
  confidence: string;
  downgraded: boolean;
  /** Kaniti ham metinde olan kapali ozellik kimlikleri (antonyms.ts `id`). */
  explicitAttributeIds: readonly string[];
}

/** Yorum duzeyindeki retler: ayni cagrinin TUM yazimlarini gecersiz kilar. */
const INTERPRETATION_LEVEL: ReadonlySet<RewriteRejection> = new Set([
  "interpretation_uncertain",
  "product_type_unverified",
  "role_changed",
]);

export interface CanonicalContext {
  lexicon: readonly LexiconEntry[];
  /**
   * Dogrulanmis yorum kaniti. Verilirse urun turu/rol/ozellik denetimleri uygulanir (onerilen).
   * Verilmezse yalniz metin kurallari calisir (E4b C+ v2 davranisi).
   */
  interpretation?: InterpretationEvidence;
  /** Bilinen markalar (sozluk `brand`); yazimda ham metinde olmayan marka uydurma sayilir. */
  knownBrands?: readonly string[];
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
  const outUnits = numberUnits(folded);
  for (const u of numberUnits(rawFolded)) {
    if (!outUnits.some((o) => o.n === u.n && o.family === u.family)) return out("unit_changed");
  }
  for (const brand of ctx.knownBrands ?? []) {
    const b = foldForMatch(brand);
    if (b.length > 2 && containsPhrase(folded, b) && !containsPhrase(rawFolded, b)) {
      return out("brand_invented");
    }
  }
  const it = ctx.interpretation;
  if (it) {
    const reason = interpretationReason(rawFolded, folded, primary, target, it, ctx.lexicon);
    if (reason) return out(reason);
  }
  const min = ctx.minCrossLingualCosine ?? DEFAULT_MIN_CROSS_LINGUAL_COSINE;
  if (ctx.crossLingualCosine != null && ctx.crossLingualCosine < min) return out("intent_drift");
  return out(null);
}

/** Bas isim kokunun yazimda varligi; cekim ekine dayanikli onek (en az 4 harf). */
function hasHeadStem(folded: string, head: string): boolean {
  const stem = head.length <= 4 ? head : head.slice(0, Math.max(4, head.length - 3));
  return folded.split(/[^a-z0-9]+/).some((w) => w.startsWith(stem));
}

function synonymsOf(term: string, lexicon: readonly LexiconEntry[]): string[] {
  const keys = new Set(
    lexicon.filter((e) => foldForMatch(e.surface) === term).map((e) => e.normalized),
  );
  return lexicon.filter((e) => keys.has(e.normalized)).map((e) => foldForMatch(e.surface));
}

function interpretationReason(
  rawFolded: string,
  folded: string,
  primary: string,
  target: string,
  it: InterpretationEvidence,
  lexicon: readonly LexiconEntry[],
): RewriteRejection | null {
  if (it.downgraded || it.confidence === "low") return "interpretation_uncertain";
  // Urun turu ham metinde kanitli degilse yazim bir tur ileri surer ("anime seven arkadasima hediye"
  // -> "anime kitap"): dil bagimsiz olarak reddedilir; arama ham sorguyla devam eder.
  if (it.productType?.source !== "explicit") return "product_type_unverified";
  if (target === primary && it.productType) {
    const head = foldForMatch(it.productType.value)
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .at(-1);
    if (
      head &&
      !hasHeadStem(folded, head) &&
      !synonymsOf(head, lexicon).some((s) => containsPhrase(folded, s))
    ) {
      return "type_anchor_lost";
    }
  }
  if (it.role === "main" && !queryWantsAccessory(rawFolded) && looksLikeAccessory(folded)) {
    return "role_changed";
  }
  const allowed = new Set<string>(it.explicitAttributeIds);
  for (const def of ATTRIBUTE_VALUES) {
    if (def.terms.some((t) => containsPhrase(rawFolded, foldForMatch(t)))) {
      allowed.add(def.id);
      const other = oppositeOf(def);
      if (other) allowed.add(other.id); // "kablosuz olmayan" -> "wired"
    }
  }
  for (const id of it.explicitAttributeIds) {
    const def = ATTRIBUTE_VALUES.find((d) => d.id === id);
    const other = def ? oppositeOf(def) : null;
    if (other) allowed.add(other.id);
  }
  for (const def of ATTRIBUTE_VALUES) {
    if (allowed.has(def.id)) continue;
    if (def.terms.some((t) => containsPhrase(folded, foldForMatch(t)))) return "attribute_invented";
  }
  return null;
}

/**
 * Ayni model cagrisinin yazim KUMESI: her yazim tek tek denetlenir; biri yorum duzeyinde (urun turu
 * kanitsiz, rol degisti, yorum belirsiz) reddedilirse ayni yorumdan gelen diger yazimlar da
 * kullanilmaz (`set_inconsistent`). Reddedilen her durumda arama HAM sorguyla devam eder.
 */
export function verifyRewriteSet(
  rawQuery: string,
  detected: { tag: string; confidence: string },
  rewrites: readonly { language: string; text: string }[],
  excluded: readonly { text: string; evidence: string | null }[],
  ctxFor: (rewrite: { language: string; text: string }) => CanonicalContext,
): { rewrite: { language: string; text: string }; verdict: CanonicalVerdict }[] {
  const results = rewrites.map((rewrite) => ({
    rewrite,
    verdict: verifyCanonicalQuery(rawQuery, detected, rewrite, excluded, ctxFor(rewrite)),
  }));
  const setLevel = results.some(
    (r) => r.verdict.reason && INTERPRETATION_LEVEL.has(r.verdict.reason),
  );
  if (!setLevel) return results;
  return results.map((r) =>
    r.verdict.accepted
      ? { ...r, verdict: { ...r.verdict, accepted: false, reason: "set_inconsistent" } }
      : r,
  );
}
