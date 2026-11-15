/**
 * Sonuçlar hakkında delilli model cevabı (karar 0203; plan Faz 7, A' pilotu). Saf fonksiyonlar:
 * DB/ağ/model yok. Model çıktısı `unknown`dır; `validateAnswer` geçmeden kullanıcıya gitmez.
 *
 * İlke: model YALNIZ o turda verilen doğrulanmış ürün gerçeklerinden yazar ve her paragrafı bir
 * alıntıyla (delil) destekler. Sunucu alıntıyı gerçekle karşılaştırır; rakamlı her sözcük bir
 * alıntıda bulunmalıdır. Katalogda teknik özellik/kalite verisi YOKTUR: bu tür iddialar reddedilir.
 */
import { cleanText } from "./contract.ts";
import { buildResultCommentary } from "./result-commentary.ts";

/** Modele giden ürün gerçeği sayısı (ve `p1..p8` kimlik uzayı). */
export const RESULT_FACT_LIMIT = 8;
export const ANSWER_MAX_PARAGRAPHS = 3;
export const ANSWER_MAX_EVIDENCE = 4;
const PARAGRAPH_MIN = 20;
const PARAGRAPH_MAX = 400;
const QUOTE_MIN = 1;
const QUOTE_MAX = 100;

export const EVIDENCE_FIELDS = ["title", "price", "brand", "store", "offer_count"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

/** Modele giden tek ürün gerçeği. Fiyat TL tam sayı; yoksa `null`. */
export interface ResultFact {
  id: string;
  title: string;
  brand: string | null;
  store: string | null;
  price_try: number | null;
  offer_count: number | null;
}

export interface AnswerEvidence {
  item: string;
  field: EvidenceField;
  quote: string;
}

export interface AnswerParagraph {
  text: string;
  evidence: AnswerEvidence[];
}

export interface ChatAnswer {
  paragraphs: AnswerParagraph[];
}

// ---------------------------------------------------------------------------
// Gerçekler
// ---------------------------------------------------------------------------

export interface FactSourceItem {
  title: string;
  brandName: string | null;
  merchantName?: string | null;
  /** Kuruş. */
  minPrice: number | null;
  offerCount?: number | null;
  /** Yurt dışı (yaklaşık) fiyat: TL karşılaştırmasına girmez. */
  foreignPrice?: unknown;
}

/** Katalog kartlarından ürün gerçekleri: en çok 8, yurt dışı yaklaşık fiyat `null`. */
export function toResultFacts(items: readonly FactSourceItem[]): ResultFact[] {
  return items.slice(0, RESULT_FACT_LIMIT).map((item, index) => ({
    id: `p${index + 1}`,
    title: item.title.slice(0, 160),
    brand: item.brandName?.trim() || null,
    store: item.merchantName?.trim() || null,
    price_try:
      item.minPrice !== null && item.minPrice > 0 && !item.foreignPrice
        ? Math.round(item.minPrice / 100)
        : null,
    offer_count: item.offerCount ?? null,
  }));
}

/**
 * Kullanıcı mesajı gösterilen sonuçlar hakkında bir soru gibi mi? Yalnızca bu durumda ürün
 * gerçekleri okunur ve modele eklenir (ek sorgu/maliyet yok). Bilinçli olarak dar: kaçan soru
 * normal akışa (arama/netleştirme) düşer.
 */
const RESULT_QUESTION_RE =
  /(?<![\p{L}\d])(?:hangisi|hangileri|fark(?:lar[ıi])?|kar[sş][ıi]la[sş]t[ıi]r\p{L}*|a[cç][ıi]kla\p{L}*|anlat\p{L}*|[oö]ner\p{L}*|tavsiye\p{L}*|daha iyi|daha uygun|aras[ıi]nda|bunlar\p{L}*|bu [uü]r[uü]nler\p{L}*)(?![\p{L}\d])/iu;

export function looksLikeResultQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 300) return false;
  return RESULT_QUESTION_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// Doğrulama
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

/** Metindeki sayı belirteçleri, binlik ayracı atılmış ("1.299" -> "1299"). */
function numericTokens(text: string): string[] {
  return (text.match(/\d[\d.,]*/g) ?? [])
    .map((token) => token.replace(/[^\d]/g, ""))
    .filter(Boolean);
}

function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, "");
}

/** Doğrulanamayan kalite/performans/uyumluluk/pazarlama iddiaları (cümle metninde). */
const FORBIDDEN_CLAIM_RE =
  /(?<![\p{L}\d])(?:en iyi|m[uü]kemmel|harika|kaliteli|kalite|performans\p{L}*|h[ıi]zl[ıi]|yava[sş]|dayan[ıi]kl[ıi]|garanti\p{L}*|uyumlu\p{L}*|ucuz\p{L}*|sat[ıi]n al\p{L}*|dupe|tavsiye ederim|kesinlikle|m[uü]thi[sş]|g[uü][cç]l[uü])(?![\p{L}\d])/iu;

const ALL_CAPS_RE = /(?<![\p{L}])[A-ZÇĞİÖŞÜ]{5,}(?![\p{L}])/u;

function quoteMatches(fact: ResultFact, field: EvidenceField, quote: string): boolean {
  if (quote.length < QUOTE_MIN || quote.length > QUOTE_MAX) return false;
  switch (field) {
    case "title":
      return quote.length >= 3 && fold(fact.title).includes(fold(quote));
    case "brand":
      return fact.brand !== null && quote.length >= 2 && fold(fact.brand).includes(fold(quote));
    case "store":
      return fact.store !== null && quote.length >= 2 && fold(fact.store).includes(fold(quote));
    case "price":
      return fact.price_try !== null && digitsOf(quote) === String(fact.price_try);
    case "offer_count":
      return fact.offer_count !== null && digitsOf(quote) === String(fact.offer_count);
  }
}

function parseEvidence(raw: unknown): AnswerEvidence | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const item = typeof record.item === "string" ? record.item.trim() : "";
  const field = record.field;
  const quote = cleanText(record.quote, QUOTE_MAX);
  if (!/^p[1-8]$/.test(item)) return null;
  if (!EVIDENCE_FIELDS.includes(field as EvidenceField)) return null;
  if (quote === null) return null;
  return { item, field: field as EvidenceField, quote };
}

/** Şema biçimini kontrol eder (kimlik/alıntı doğruluğu `validateAnswer`da). Geçersizse `null`. */
export function parseAnswer(raw: unknown): ChatAnswer | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const list = (raw as Record<string, unknown>).paragraphs;
  if (!Array.isArray(list) || list.length === 0 || list.length > ANSWER_MAX_PARAGRAPHS + 2) {
    return null;
  }
  const paragraphs: AnswerParagraph[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const text = cleanText(record.text, PARAGRAPH_MAX + 200);
    const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
    if (text === null) return null;
    const evidence = rawEvidence
      .slice(0, ANSWER_MAX_EVIDENCE + 4)
      .map(parseEvidence)
      .filter((e): e is AnswerEvidence => e !== null);
    paragraphs.push({ text, evidence });
  }
  return { paragraphs };
}

export interface AnswerVerdict {
  /** Doğrulanan paragraflar (en çok 3); boşsa cevap kullanılamaz. */
  answer: ChatAnswer | null;
  /** Atılan paragraf nedenleri (sabit kod; metin değil). */
  rejected: string[];
}

function paragraphProblem(paragraph: AnswerParagraph, facts: ReadonlyMap<string, ResultFact>) {
  const { text } = paragraph;
  if (text.length < PARAGRAPH_MIN || text.length > PARAGRAPH_MAX) return "length";
  if (FORBIDDEN_CLAIM_RE.test(text)) return "forbidden_claim";
  if (ALL_CAPS_RE.test(text)) return "all_caps";
  if (/https?:\/\/|www\./i.test(text)) return "url";
  const evidence = paragraph.evidence.slice(0, ANSWER_MAX_EVIDENCE);
  if (evidence.length === 0) return "no_evidence";
  for (const item of evidence) {
    const fact = facts.get(item.item);
    if (!fact) return "unknown_item";
    if (!quoteMatches(fact, item.field, item.quote)) return "quote_mismatch";
  }
  // Rakamlı her sözcük bu paragrafın bir alıntısında geçmeli (uydurma sayı/özellik engeli): sayı
  // BELİRTEÇLERİ eşleşir (alt dize değil): "12" metinde, alıntıda yalnız "1299" varsa reddedilir.
  const allowed = new Set(evidence.flatMap((e) => numericTokens(e.quote)));
  for (const word of text.split(/\s+/)) {
    if (!/\d/.test(word)) continue;
    if (numericTokens(word).some((token) => !allowed.has(token))) return "unevidenced_number";
  }
  return null;
}

/**
 * Model cevabını gerçeklere karşı doğrular: geçen paragraflar korunur (en çok 3), kalanlar atılır.
 * `answer: null` ise hiçbir paragraf güvenli değildir ve model cevabı kullanıcıya GÖSTERİLMEZ.
 */
export function validateAnswer(raw: unknown, facts: readonly ResultFact[]): AnswerVerdict {
  const parsed = parseAnswer(raw);
  if (parsed === null) return { answer: null, rejected: ["schema"] };
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const kept: AnswerParagraph[] = [];
  const rejected: string[] = [];
  for (const paragraph of parsed.paragraphs) {
    const problem = paragraphProblem(paragraph, byId);
    if (problem === null && kept.length < ANSWER_MAX_PARAGRAPHS) {
      kept.push({ ...paragraph, evidence: paragraph.evidence.slice(0, ANSWER_MAX_EVIDENCE) });
    } else rejected.push(problem ?? "limit");
  }
  return { answer: kept.length > 0 ? { paragraphs: kept } : null, rejected };
}

/** Kullanıcıya gösterilen metin: doğrulanan paragraflar boş satırla ayrılır. */
export function answerText(answer: ChatAnswer): string {
  return answer.paragraphs.map((p) => p.text).join("\n\n");
}

/**
 * Model cevabı kullanılamadığında MODELSİZ yedek (karar 0201 ile aynı olgusal özet). Gerçek yoksa
 * dürüst bir "yapamadım" cümlesi; hiçbir durumda uydurma içerik yok.
 */
export function fallbackAnswerText(facts: readonly ResultFact[], seed: string): string {
  const summary = buildResultCommentary(
    facts.map((fact) => ({
      minPrice: fact.price_try === null ? null : fact.price_try * 100,
      brandName: fact.brand,
      merchantName: fact.store,
    })),
    { seed },
  );
  if (summary === null) {
    return "Bu ürünleri şu an güvenle karşılaştıramadım. Mağaza ve fiyat bilgilerini kartlardan inceleyebilirsin.";
  }
  return `Ürünleri karşılaştırmalı yorumlayamadım; doğrulanmış verilere göre özet: ${summary.sentences.join(" ")}`;
}
