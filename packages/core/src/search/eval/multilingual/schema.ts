/**
 * Cok dilli degerlendirme kumesi: sema ve dogrulayici (karar: dilden bagimsiz, yeni dil = yalniz veri).
 *
 * Saf ve veritabanisiz. Dil kodlari BCP-47 etiketidir; dil cifti `query_lang>doc_lang` olarak
 * TURETILIR, saklanmaz. Kodda dil listesi yoktur: gecerli diller `data/languages.json` kaydindan gelir.
 *
 * Etiket kurali: yalnizca `label_source = "human"` kayitlar etiket tasir ve metrige girer.
 * `ai_preliminary_label` ayri bir bilgi alanidir; hicbir metrik onu okumaz.
 */

export const LABEL_SOURCES = ["human", "ai_preliminary", "none"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export const LABEL_SCALE = [0, 1, 2, 3] as const;
export type Label = (typeof LABEL_SCALE)[number];

export const TEXT_SOURCES = ["original", "existing_draft", "manual_draft"] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

export const TRANSLATION_STATUSES = ["source_text", "draft_unverified", "human_verified"] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];

export const INTENT_TYPES = [
  "category",
  "technical",
  "model_number",
  "negation",
  "natural_language",
  "accessory_part",
  "absent_expected",
] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

export interface LanguageEntry {
  tag: string;
  name: string;
  /** active: veride kullaniliyor; open: acik, eklenebilir (henuz veri yok). */
  status: "active" | "open";
}

export interface IntentRecord {
  intent_id: string;
  intent_type: IntentType;
  description: string;
  origin: string;
  origin_query_ids: string[];
  /** Yalniz ipucu: etiket degildir, metrige girmez. */
  expected_hint: { title_regex: string; flags: string; note: string };
  slice: number;
}

export interface QueryRecord {
  query_id: string;
  intent_id: string;
  query_lang: string;
  text: string;
  text_source: TextSource;
  translation_status: TranslationStatus;
}

export interface CandidateItem {
  item_id: string;
  query_id: string;
  intent_id: string;
  query_lang: string;
  doc_id: string;
  doc_lang: string;
  slice: number;
  label_source: LabelSource;
  /** Yalniz label_source = "human" iken dolu. */
  label: Label | null;
  /** Bilgi alani: yapay zeka on etiketi. Metriklere GIRMEZ. */
  ai_preliminary_label: Label | null;
  annotator?: string;
}

export interface Dataset {
  languages: LanguageEntry[];
  intents: IntentRecord[];
  queries: QueryRecord[];
  items: CandidateItem[];
}

/** Basit BCP-47 sekli: dil[-yazi][-bolge]... (gercek kayit denetimi yok, bilerek). */
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isBcp47(tag: string): boolean {
  return BCP47.test(tag);
}

/** Dil cifti turetilir: `tr>en`. */
export function languagePair(queryLang: string, docLang: string): string {
  return `${queryLang}>${docLang}`;
}

export function isLabel(value: unknown): value is Label {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3;
}

/** Yalniz insan etiketli kayitlar: metriklere giren tek kume. */
export function humanLabeled(items: readonly CandidateItem[]): CandidateItem[] {
  return items.filter((item) => item.label_source === "human" && isLabel(item.label));
}

export function validateDataset(data: Dataset): string[] {
  const errors: string[] = [];
  const langs = new Map(data.languages.map((entry) => [entry.tag, entry]));
  if (langs.size !== data.languages.length) errors.push("languages: tekrarlanan etiket");
  for (const entry of data.languages) {
    // "und" yalniz belge dili icin; sorgu dili olarak asagida ayrica reddedilir.
    if (entry.tag !== "und" && !isBcp47(entry.tag)) errors.push(`languages: gecersiz ${entry.tag}`);
    if (entry.status !== "active" && entry.status !== "open") {
      errors.push(`languages: ${entry.tag} durumu gecersiz`);
    }
  }

  const intents = new Map(data.intents.map((intent) => [intent.intent_id, intent]));
  if (intents.size !== data.intents.length) errors.push("intents: tekrarlanan intent_id");
  for (const intent of data.intents) {
    if (!INTENT_TYPES.includes(intent.intent_type)) {
      errors.push(`intent ${intent.intent_id}: bilinmeyen tur ${intent.intent_type}`);
    }
    try {
      new RegExp(intent.expected_hint.title_regex, intent.expected_hint.flags);
    } catch {
      errors.push(`intent ${intent.intent_id}: ipucu regex gecersiz`);
    }
  }

  const queries = new Map(data.queries.map((query) => [query.query_id, query]));
  if (queries.size !== data.queries.length) errors.push("queries: tekrarlanan query_id");
  const langsPerIntent = new Map<string, Set<string>>();
  for (const query of data.queries) {
    if (!intents.has(query.intent_id)) errors.push(`query ${query.query_id}: bilinmeyen intent`);
    if (query.query_lang === "und" || !isBcp47(query.query_lang) || !langs.has(query.query_lang)) {
      errors.push(`query ${query.query_id}: dil kayitli degil ${query.query_lang}`);
    }
    if (query.text.trim() === "") errors.push(`query ${query.query_id}: bos metin`);
    if (!TEXT_SOURCES.includes(query.text_source))
      errors.push(`query ${query.query_id}: text_source`);
    if (!TRANSLATION_STATUSES.includes(query.translation_status)) {
      errors.push(`query ${query.query_id}: translation_status`);
    }
    if (query.text_source !== "original" && query.translation_status === "source_text") {
      errors.push(`query ${query.query_id}: ceviri 'source_text' sayilamaz`);
    }
    const set = langsPerIntent.get(query.intent_id) ?? new Set<string>();
    if (set.has(query.query_lang))
      errors.push(`intent ${query.intent_id}: ${query.query_lang} iki kez`);
    set.add(query.query_lang);
    langsPerIntent.set(query.intent_id, set);
  }
  for (const intent of data.intents) {
    if ((langsPerIntent.get(intent.intent_id)?.size ?? 0) < 1) {
      errors.push(`intent ${intent.intent_id}: sorgu yok`);
    }
  }

  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const item of data.items) {
    if (ids.has(item.item_id)) errors.push(`item ${item.item_id}: tekrarlanan item_id`);
    ids.add(item.item_id);
    const key = `${item.query_id}|${item.doc_id}`;
    if (pairs.has(key)) errors.push(`item ${item.item_id}: (sorgu, belge) tekrar`);
    pairs.add(key);
    const query = queries.get(item.query_id);
    if (!query) {
      errors.push(`item ${item.item_id}: bilinmeyen sorgu`);
    } else {
      if (query.query_lang !== item.query_lang)
        errors.push(`item ${item.item_id}: sorgu dili uyusmuyor`);
      if (query.intent_id !== item.intent_id) errors.push(`item ${item.item_id}: intent uyusmuyor`);
    }
    if (!isBcp47(item.doc_lang) || !langs.has(item.doc_lang)) {
      errors.push(`item ${item.item_id}: belge dili kayitli degil ${item.doc_lang}`);
    }
    if (!LABEL_SOURCES.includes(item.label_source)) {
      errors.push(`item ${item.item_id}: label_source gecersiz`);
    }
    if (item.label_source === "human") {
      if (!isLabel(item.label)) errors.push(`item ${item.item_id}: human icin etiket 0-3 olmali`);
      if (!item.annotator || item.annotator.trim() === "") {
        errors.push(`item ${item.item_id}: human icin annotator gerekli`);
      }
    } else if (item.label !== null) {
      errors.push(`item ${item.item_id}: human olmayan kayitta etiket olamaz`);
    }
    if (item.label_source === "ai_preliminary" && !isLabel(item.ai_preliminary_label)) {
      errors.push(`item ${item.item_id}: ai_preliminary icin ai_preliminary_label gerekli`);
    }
    if (item.label_source === "none" && item.ai_preliminary_label !== null) {
      errors.push(`item ${item.item_id}: none kaydinda ai_preliminary_label olamaz`);
    }
    if (item.ai_preliminary_label !== null && !isLabel(item.ai_preliminary_label)) {
      errors.push(`item ${item.item_id}: ai_preliminary_label 0-3 olmali`);
    }
  }
  return errors;
}
