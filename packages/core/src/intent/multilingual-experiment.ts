/**
 * E4b C+ DENEYSEL sozlesme: mevcut TEK IntentV2 cagrisina dil bagimsiz sorgu anlama alanlari ekler.
 * ISTEK YOLUNA BAGLI DEGILDIR; uretimdeki `INTENT_V2_INSTRUCTIONS`/sema ve onbellek ozeti DEGISMEZ.
 *
 * Mimari ilkeler (hicbir dil sabit kodla zorunlu degildir):
 * - Kullanicinin HAM sorgusu her zaman korunur ve aranir; yazimlar yalniz yardimci temsildir.
 * - Sorgu dili ile urun basligi dili BAGIMSIZDIR. Katalog arama dilleri bir YAPILANDIRMA listesidir
 *   (`MultilingualConfig.catalogLanguages`); bugun katalogda Ingilizce ve Turkce basliklar oldugu icin
 *   varsayilan ["en", "tr"]. Yeni dil = listeye kayit; sema/istem/dogrulayici yeniden yazilmaz ve urun
 *   embedding'leri yeniden uretilmez (BGE-M3 cok dilli; ayni urun vektoru her dildeki sorguyla kullanilir).
 * - Model ciktisi KANIT DEGILDIR: kategori kaynagi sozlesmesi (karar 0190) ve IntentV2 dogrulayicisi
 *   (validate.ts) aynen gecerlidir; yazimlar `verifyCanonicalQuery` ile dogrulanmadan kullanilmaz.
 */
import { createHash } from "node:crypto";
import {
  buildIntentV2Input,
  buildIntentV2JsonSchema,
  INTENT_V2_INSTRUCTIONS,
  intentV2ContractHash,
} from "./contract.ts";

/** BCP 47 dil etiketi (or. "tr", "en", "de", "pt-BR"); bilinmiyorsa "und". */
export type LanguageTag = string;

export interface MultilingualConfig {
  /** Katalogdaki baslik dilleri (yapilandirma; sabit kod degil). Yazim hedefi yalniz bunlardan olabilir. */
  catalogLanguages: readonly LanguageTag[];
  /** Kabul edilen sorgu dilleri; "any" = her dil (yalniz `und`/dusuk guven geri duser). */
  acceptedQueryLanguages: readonly LanguageTag[] | "any";
  /**
   * `optional` (varsayilan, v3): yazim ISTEGE BAGLIDIR; hicbir katalog dili zorunlu degildir, model
   * anlami birebir koruyamiyorsa ya da urun turu metinde yoksa yazmaz.
   * `per_catalog_language` (alan yoksa): E4b C+ kosusunda (14 Kasim, 120 cagri) kullanilan sozlesme;
   * her katalog dili icin yazim ister. Yalniz o kosunun yeniden uretilebilirligi icin tutulur.
   */
  alternativesPolicy?: "optional" | "per_catalog_language";
}

export const DEFAULT_MULTILINGUAL_CONFIG: MultilingualConfig = {
  catalogLanguages: ["en", "tr"],
  acceptedQueryLanguages: "any",
  alternativesPolicy: "optional",
};

/** 14 Kasim 2026 E4b C+ kosusunun sozlesmesi (kayitlardaki `contractHash` bununla uretildi). */
export const E4B_CPLUS_RUN_CONFIG: MultilingualConfig = {
  catalogLanguages: ["en", "tr"],
  acceptedQueryLanguages: "any",
};

export const MAX_ALTERNATIVES = 4;
export const MAX_EXCLUDED_FEATURES = 3;
const MAX_TEXT = 80;

export interface LanguageText {
  language: LanguageTag;
  text: string;
}

export interface MultilingualFields {
  detected_language: { tag: LanguageTag; confidence: "high" | "medium" | "low" };
  search_queries: LanguageText[];
  alternative_search_terms: LanguageText[];
  excluded_features: { language: LanguageTag; text: string; evidence: string | null }[];
}

/** Ortak sorgu temsili (dil bagimsiz veri sozlesmesi). */
export interface QueryRepresentation {
  original: { text: string; language: LanguageTag; confidence: "high" | "medium" | "low" };
  /** Dogrulayicidan GECEN yazimlar (katalog dili basina en fazla bir). */
  rewrites: LanguageText[];
  /** Reddedilen yazimlar ve nedenleri (izleme icin). */
  rejected: { rewrite: LanguageText; reason: string }[];
  alternatives: LanguageText[];
  /** Kaniti ham metinde dogrulanmis dislamalar. */
  excluded: string[];
}

/** Urun metni temsili: baslik dili urunden urune degisebilir; bilinmiyorsa "und". */
export interface ProductTextRepresentation {
  productId: number;
  title: string;
  titleLanguage: LanguageTag;
}

export function buildMultilingualInstructions(config: MultilingualConfig): string {
  return [
    INTENT_V2_INSTRUCTIONS.replace(
      "Türkçe ya da İngilizce alışveriş sorgusunu",
      "Herhangi bir dildeki (karışık diller dahil) alışveriş sorgusunu",
    ),
    "detected_language: sorgunun dilini BCP 47 etiketiyle yaz; karışıksa baskın dili yaz; emin değilsen 'und'. confidence high/medium/low.",
    (config.alternativesPolicy ?? "per_catalog_language") === "per_catalog_language"
      ? `search_queries: catalog_languages listesindeki (${config.catalogLanguages.join(", ")}) HER dil için, aynı ürün isteğini o dilde kısa bir ürün arama ifadesi olarak yaz (language alanı o dilin etiketi). Marka, model numarası, sayı ve birimleri AYNEN koru. Olumsuzlanan özelliği olumlu yazma (gerekirse karşıtını ya da o dildeki 'olmadan' ifadesini kullan). Fiyat, bütçe ya da kullanıcının yazmadığı özellik ekleme. Anlam belirsizse o dil için yazma.`
      : `search_queries: İSTEĞE BAĞLI; hiçbir dil zorunlu değildir. Yalnızca aynı ürün isteğini birebir koruyabiliyorsan, catalog_languages listesindeki (${config.catalogLanguages.join(", ")}) dillerden aramaya katkı sağlayacak olanlar için kısa bir ürün arama ifadesi yaz (dil başına en fazla bir; language alanı o dilin etiketi). Kullanıcı ürün türünü açıkça yazmadıysa (ör. yalnızca 'hediye') ürün türü uydurma; boş bırak. Marka, model numarası, sayı ve birimleri AYNEN koru. Olumsuzlanan özelliği olumlu yazma. Fiyat, bütçe, marka ya da kullanıcının yazmadığı özellik ekleme. Emin değilsen boş bırak.`,
    `alternative_search_terms: ürünün katalogda geçebilecek en fazla ${MAX_ALTERNATIVES} kısa adı (yalnızca ürün türü adları, catalog_languages dillerinde; özellik ekleme).`,
    `excluded_features: kullanıcının açıkça istemediği en fazla ${MAX_EXCLUDED_FEATURES} özellik; text herhangi bir catalog_languages dilinde terim, language onun etiketi, evidence kullanıcının metninden birebir parça.`,
  ].join("\n");
}

const languageText = (maxItems: number) => ({
  type: "array",
  maxItems,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["language", "text"],
    properties: {
      language: { type: "string", maxLength: 20 },
      text: { type: "string", maxLength: MAX_TEXT },
    },
  },
});

export function buildMultilingualSchema(config: MultilingualConfig): Record<string, unknown> {
  const base = buildIntentV2JsonSchema() as unknown as {
    required: string[];
    properties: Record<string, unknown>;
  };
  return {
    ...base,
    required: [
      ...base.required,
      "detected_language",
      "search_queries",
      "alternative_search_terms",
      "excluded_features",
    ],
    properties: {
      ...base.properties,
      detected_language: {
        type: "object",
        additionalProperties: false,
        required: ["tag", "confidence"],
        properties: {
          tag: { type: "string", maxLength: 20 },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
      search_queries: languageText(config.catalogLanguages.length),
      alternative_search_terms: languageText(MAX_ALTERNATIVES),
      excluded_features: {
        type: "array",
        maxItems: MAX_EXCLUDED_FEATURES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["language", "text", "evidence"],
          properties: {
            language: { type: "string", maxLength: 20 },
            text: { type: "string", maxLength: 40 },
            evidence: { type: ["string", "null"], maxLength: MAX_TEXT },
          },
        },
      },
    },
  };
}

export function buildMultilingualInput(rawQuery: string, config: MultilingualConfig): string {
  const base = JSON.parse(buildIntentV2Input(rawQuery)) as Record<string, unknown>;
  return JSON.stringify({ ...base, catalog_languages: config.catalogLanguages });
}

export function multilingualContractHash(config: MultilingualConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        base: intentV2ContractHash(),
        instructions: buildMultilingualInstructions(config),
        schema: buildMultilingualSchema(config),
        config,
      }),
      "utf8",
    )
    .digest("hex");
}

const asLanguageTexts = (value: unknown, max: number): LanguageText[] =>
  Array.isArray(value)
    ? value
        .filter(
          (x): x is LanguageText =>
            Boolean(x) &&
            typeof (x as LanguageText).language === "string" &&
            typeof (x as LanguageText).text === "string",
        )
        .slice(0, max)
    : [];

/** Model ciktisindan yeni alanlari kati bicimde ayiklar; bicim disi -> null (guvenli geri dusus). */
export function parseMultilingualFields(raw: unknown): MultilingualFields | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const lang = r.detected_language as Record<string, unknown> | undefined;
  if (
    !lang ||
    typeof lang.tag !== "string" ||
    !["high", "medium", "low"].includes(String(lang.confidence))
  ) {
    return null;
  }
  const excluded = Array.isArray(r.excluded_features)
    ? r.excluded_features
        .filter(
          (x): x is { language: string; text: string; evidence: string | null } =>
            Boolean(x) && typeof (x as { text?: unknown }).text === "string",
        )
        .map((x) => ({
          language: typeof x.language === "string" ? x.language : "und",
          text: x.text,
          evidence: typeof x.evidence === "string" ? x.evidence : null,
        }))
        .slice(0, MAX_EXCLUDED_FEATURES)
    : [];
  return {
    detected_language: {
      tag: lang.tag,
      confidence: lang.confidence as "high" | "medium" | "low",
    },
    search_queries: asLanguageTexts(r.search_queries, 8),
    alternative_search_terms: asLanguageTexts(r.alternative_search_terms, MAX_ALTERNATIVES),
    excluded_features: excluded,
  };
}

/**
 * Baslik dili icin ihtiyatli ipucu (yalniz raporlama/analiz; arama kararina girmez). Kisa
 * basliklarda ve model kodlarinda dil tespiti guvenilmez: harf disi yogunluk ya da az kelime -> "und".
 * Isaretler dil -> ozgun karakter/sik kelime VERI tablosudur; yeni dil = tabloya kayit.
 */
export const TITLE_LANGUAGE_MARKERS: Readonly<
  Record<LanguageTag, { chars?: RegExp; words: readonly string[] }>
> = {
  tr: {
    chars: /[ğşıİĞŞ]/,
    words: ["ve", "için", "ile", "erkek", "kadın", "çocuk", "bebek", "adet", "lı", "li"],
  },
  de: { chars: /[ß]/, words: ["und", "für", "mit", "der", "die", "das", "kinder", "damen"] },
  en: { words: ["and", "for", "with", "the", "women", "men", "kids", "set", "pcs"] },
};

export function guessTitleLanguage(title: string): {
  tag: LanguageTag;
  confidence: "high" | "low";
} {
  const words = title
    .toLocaleLowerCase("tr-TR")
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 1);
  if (words.length < 3) return { tag: "und", confidence: "low" };
  let best: LanguageTag = "und";
  let bestScore = 0;
  for (const [tag, marker] of Object.entries(TITLE_LANGUAGE_MARKERS)) {
    const score =
      words.filter((w) => marker.words.includes(w)).length + (marker.chars?.test(title) ? 2 : 0);
    if (score > bestScore) {
      best = tag;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? { tag: best, confidence: "high" } : { tag: best, confidence: "low" };
}

// --- dil bagimsiz sorgu anlama sozlesmesi (E4b C+ v3) ------------------------------------------

/** Bir cikarimin kanit durumu: ham metne karsi dogrulandi mi, yalniz model mi soyledi, reddedildi mi. */
export type EvidenceStatus = "verified" | "model_only" | "rejected";

export interface Evidenced<T> {
  value: T;
  /** Kullanicinin metninden birebir parca (varsa). */
  evidence: string | null;
  status: EvidenceStatus;
}

/**
 * Istek yolundan BAGIMSIZ, dil bagimsiz sorgu anlama sozlesmesi (`qu-1`). Hicbir alan belirli bir dili
 * zorunlu kilmaz; ham sorgu her zaman korunur ve aranir. Alternatifler YARDIMCI aday kaynagidir, kesin
 * filtre ya da kategori kaniti degildir (karar 0190). Bos alternatif listesi gecerli ve guvenli durumdur.
 */
export interface QueryUnderstanding {
  contractVersion: "qu-1";
  /** Kullanicinin degistirilmemis sorgusu. */
  original: string;
  /** Algilanan dil (BCP 47); belirlenemezse null. */
  detectedLanguage: { tag: LanguageTag; confidence: "high" | "medium" | "low" } | null;
  /** Kullanicinin istedigi ana urun turu; kaniti ham metinde yoksa `model_only`. */
  productType: Evidenced<string> | null;
  /** Ana urun / aksesuar / parca ayrimi (dogrulanmis yorumdan). */
  role: string | null;
  /** Ham metinden cikarilan kesin teknik ozellikler (model kodu, kapasite); dilden bagimsiz. */
  exactSpecs: readonly string[];
  /** Olumsuzluk ve dislamalar; yalniz kaniti ham metinde olanlar `verified`. */
  exclusions: readonly Evidenced<string>[];
  /** Dogrulayicidan gecen ya da reddedilen yardimci sorgular; hedef dili her biri icin ayri. */
  alternatives: readonly {
    language: LanguageTag;
    text: string;
    accepted: boolean;
    reason: string | null;
  }[];
  /** Model cagrisi yoksa/basarisizsa ya da hicbir alternatif kabul edilmediyse `raw_only`. */
  plan: "raw_only" | "raw_plus_alternatives";
}

export function buildQueryUnderstanding(input: {
  original: string;
  fields: MultilingualFields | null;
  productType: { value: string; source: string; evidence?: string | null } | null;
  role: string | null;
  exactSpecs: readonly string[];
  /** Dogrulayicinin ham metinde kanitini buldugu dislamalar (katlanmis). */
  verifiedExcluded: readonly string[];
  /** Katlama fonksiyonu (dogrulayiciyla ayni; `foldForMatch`). */
  fold: (s: string) => string;
  verdicts: readonly { rewrite: LanguageText; accepted: boolean; reason: string | null }[];
}): QueryUnderstanding {
  const fields = input.fields;
  const verified = new Set(input.verifiedExcluded);
  const alternatives = input.verdicts.map((v) => ({
    language: v.rewrite.language,
    text: v.rewrite.text,
    accepted: v.accepted,
    reason: v.reason,
  }));
  const tag = fields?.detected_language.tag ?? "und";
  return {
    contractVersion: "qu-1",
    original: input.original,
    detectedLanguage:
      !fields || tag.toLowerCase() === "und" ? null : { ...fields.detected_language },
    productType: input.productType
      ? {
          value: input.productType.value,
          evidence: input.productType.evidence ?? null,
          status: input.productType.source === "explicit" ? "verified" : "model_only",
        }
      : null,
    role: input.role,
    exactSpecs: [...input.exactSpecs],
    exclusions: (fields?.excluded_features ?? []).map((f) => ({
      value: f.text,
      evidence: f.evidence,
      status: verified.has(input.fold(f.text))
        ? "verified"
        : f.evidence
          ? "rejected"
          : "model_only",
    })),
    alternatives,
    plan: alternatives.some((a) => a.accepted) ? "raw_plus_alternatives" : "raw_only",
  };
}
