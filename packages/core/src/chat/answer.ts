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
const FORBIDDEN_STRONG_RE =
  /(?<![\p{L}\d])(?:en iyi|m[uü]kemmel\p{L}*|harika\p{L}*|ucuz\p{L}*|sat[ıi]n al\p{L}*|dupe|tavsiye ederim|kesinlikle|m[uü]thi[sş])(?![\p{L}\d])/iu;
const FORBIDDEN_TOPIC_RE =
  /(?<![\p{L}\d])(?:kalite\p{L}*|performans\p{L}*|h[ıi]zl[ıi]\p{L}*|yava[sş]\p{L}*|dayan[ıi]kl[ıi]\p{L}*|dayan[ıi]m\p{L}*|garanti\p{L}*|uyumlu\p{L}*|g[uü][cç]l[uü]\p{L}*|teknolojik\p{L}*|imkan\p{L}*|tasarlan\p{L}*|y[oö]nelik|ama[cç]l[ıi]|kullan[ıi]ma uygun|ideal\p{L}*|geli[sş]mi[sş]\p{L}*|kapsaml[ıi]\p{L}*|pratik|hitap|geni[sş] (?:[oö]zellik|depolama|kapasite|alan)\p{L}*|[oö]zellik set\p{L}*)(?![\p{L}\d])/iu;
/** Verinin YOKLUĞUNU söyleyen cümle ("başlıkta belirtilmemiş", "bilgi yok", "karşılaştıramıyorum"). */
const ABSENCE_RE =
  /(?<![\p{L}\d])(?:belirtilme(?:mi[sş]|yor|di)\p{L}*|(?:verilme|payla[sş][ıi]lma|sunulma|ifade edilme)(?:mi[sş]|yor|di)\p{L}*|yer al(?:m[ıi]yor|mad[ıi]|mamak)\p{L}*|bulunm(?:uyor|amak|ad[ıi])\p{L}*|bilgi(?:si)? yok\p{L}*|veri(?:si)? yok\p{L}*|mevcut de[gğ]il\p{L}*|k[ıi]yaslayam[ıi]yorum|de[gğ]erlendiremiyorum|kar[sş][ıi]la[sş]t[ıi]ram[ıi]yorum|s[oö]yleyemiyorum|bilmiyorum)(?![\p{L}\d])/iu;

/**
 * İnsan denetimi (15 Kas 2026 pilotu, 134 cevap) ile doğrulanan çıkarım kalıpları; her biri etiketli
 * kümede doğru cevap kaybettirmeden kritik hata yakaladı (karar 0212):
 * - ihtiyaç varsayan çerçeve: "daha hafif bir çözüm arıyorsanız", "… istersen", "… ihtiyacınız varsa"
 * - fiyat dışı karşılaştırma: "daha hafif/sade/…" (fiyat, teklif ve sayı karşılaştırması serbest)
 * - üretim amacı/etki: "… için üretilmiş", "özel üretilmiş", "geliştirilmiştir", "gereksinimlerini
 *   karşılamak", "yardımcı olabilir", "kişiselleştirmek", "oyun deneyimi"
 * - yetenek: "eşleşebilen", "yönetebilen" (başlıkta yazmayan işlev)
 * - öznel sınıflama: "orta segment", "klasik bir seçenek", "değerlendirebileceğiniz"
 * Konu iddiaları gibi, yalnız verinin yokluğunu söyleyen yan cümlede serbesttir.
 */
const FORBIDDEN_INFERENCE_RE =
  /(?<![\p{L}\d])(?:ar[ıi]yorsan\p{L}*|istersen\p{L}*|d[uü][sş][uü]n[uü]yorsan\p{L}*|ihtiya[cç]\p{L}* varsa|daha (?!uygun fiyat|d[uü][sş][uü]k|y[uü]ksek|pahal[ıi]|fazla|az(?![\p{L}\d])|[cç]ok(?![\p{L}\d]))\p{L}+|i[cç]in [uü]retil\p{L}*|[oö]zel [uü]retil\p{L}*|geli[sş]tiril\p{L}*|gereksinim\p{L}*|ki[sş]iselle[sş]tir\p{L}*|yard[ıi]mc[ıi] ol\p{L}*|deneyim\p{L}*|segment\p{L}*|klasik bir se[cç]enek|de[gğ]erlendirebilece\p{L}*|\p{L}{3,}[ae]bilen)(?![\p{L}\d])/iu;
/**
 * Modele verilmeyen kaynaklar: yalnız başlık, marka, mağaza, fiyat ve teklif sayısı verilir. "Ürün
 * açıklamalarında … yok" demek, okunmamış bir kaynak hakkında iddiadır; yokluk cümlesinde de yasak.
 */
const NONEXISTENT_SOURCE_RE = /(?<![\p{L}\d])a[cç][ıi]klama(?:lar)?[ıi]nda(?![\p{L}\d])/iu;

/**
 * Güçlü iddialar (üstünlük/pazarlama) HER cümlede yasak. Konu iddiaları (kalite/performans/hız/
 * dayanıklılık/garanti/uyumluluk) yalnız verinin yokluğunu söyleyen cümlede serbest: "başlıkta
 * dayanıklılık bilgisi belirtilmemiş" dürüst cevaptır; olumlu iddia olarak yazılırsa yasak.
 */
function forbiddenClaim(text: string): boolean {
  if (FORBIDDEN_STRONG_RE.test(text) || NONEXISTENT_SOURCE_RE.test(text)) return true;
  return text
    .split(/(?<=[.!?;,])\s+|\s+(?:ancak|ama|fakat|oysa)\s+/i)
    .some(
      (clause) =>
        (FORBIDDEN_TOPIC_RE.test(clause) || FORBIDDEN_INFERENCE_RE.test(clause)) &&
        !ABSENCE_RE.test(clause),
    );
}

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

function paragraphProblem(
  paragraph: AnswerParagraph,
  facts: ReadonlyMap<string, ResultFact>,
  userNumbers: ReadonlySet<string> = new Set(),
) {
  const { text } = paragraph;
  if (text.length < PARAGRAPH_MIN || text.length > PARAGRAPH_MAX) return "length";
  if (forbiddenClaim(text)) return "forbidden_claim";
  // Ürün kimlikleri (p1..p8) yalnız model ile sunucu arasındadır; kullanıcıya görünmez.
  if (/(?<![\p{L}\d])p[1-8](?![\p{L}\d])/u.test(text)) return "internal_id";
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
  // Fiyat/teklif iddiaları ("849 TL") yalnız o alıntılarla ya da kullanıcının kendi sayısıyla
  // desteklenir. Diğer sayılar (model adı "Power Bank 3", "5000mAh") alıntılanan ürünün BAŞLIĞINDA
  // da geçebilir. "(p2)" gibi ürün kimlikleri sayı değildir.
  const strict = new Set([
    ...evidence
      .filter((e) => e.field === "price" || e.field === "offer_count")
      .flatMap((e) => numericTokens(e.quote)),
    ...userNumbers,
  ]);
  const loose = new Set([
    ...strict,
    ...evidence.flatMap((e) => numericTokens(e.quote)),
    ...evidence.flatMap((e) => {
      const fact = facts.get(e.item);
      return numericTokens(`${fact?.title ?? ""} ${fact?.brand ?? ""} ${fact?.store ?? ""}`);
    }),
  ]);
  const words = text.split(/\s+/);
  for (const [index, word] of words.entries()) {
    if (!/\d/.test(word) || /^\(?p[1-8]\)?[.,;:]?$/i.test(word)) continue;
    const next = words[index + 1] ?? "";
    const isMoney = /(?:TL|₺)[.,;:)]*$/i.test(word) || /^(?:TL|₺|lira)/i.test(next);
    const allowed = isMoney ? strict : loose;
    if (numericTokens(word).some((token) => !allowed.has(token))) return "unevidenced_number";
  }
  return null;
}

/**
 * Model cevabını gerçeklere karşı doğrular: geçen paragraflar korunur (en çok 3), kalanlar atılır.
 * `answer: null` ise hiçbir paragraf güvenli değildir ve model cevabı kullanıcıya GÖSTERİLMEZ.
 */
export function validateAnswer(
  raw: unknown,
  facts: readonly ResultFact[],
  context: { question?: string } = {},
): AnswerVerdict {
  const parsed = parseAnswer(raw);
  if (parsed === null) return { answer: null, rejected: ["schema"] };
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const userNumbers = new Set(numericTokens(context.question ?? ""));
  const kept: AnswerParagraph[] = [];
  const rejected: string[] = [];
  for (const paragraph of parsed.paragraphs) {
    const problem = paragraphProblem(paragraph, byId, userNumbers);
    if (problem === null && kept.length < ANSWER_MAX_PARAGRAPHS) {
      kept.push({ ...paragraph, evidence: paragraph.evidence.slice(0, ANSWER_MAX_EVIDENCE) });
    } else rejected.push(problem ?? "limit");
  }
  return { answer: kept.length > 0 ? { paragraphs: kept } : null, rejected };
}

/** Tanı (değerlendirme/denetim): her ham paragraf, kendi red nedeni ve delilsiz sayılarıyla. */
export interface ParagraphInspection {
  paragraph: AnswerParagraph;
  /** `null` = geçti. */
  problem: string | null;
  /** `unevidenced_number` için metinde olup hiçbir alıntıda bulunmayan sayı belirteçleri. */
  unevidencedNumbers: string[];
}

/**
 * Doğrulama kararını DEĞİŞTİRMEZ; `validateAnswer` ile aynı kuralları uygular ama atılan paragrafın
 * ham metnini ve nedenini korur. Yalnız ölçüm/denetim araçları için (kullanıcıya gösterilmez).
 */
export function inspectAnswer(
  raw: unknown,
  facts: readonly ResultFact[],
  context: { question?: string } = {},
): ParagraphInspection[] | null {
  const parsed = parseAnswer(raw);
  if (parsed === null) return null;
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const userNumbers = new Set(numericTokens(context.question ?? ""));
  return parsed.paragraphs.map((paragraph) => {
    const problem = paragraphProblem(paragraph, byId, userNumbers);
    const cited = paragraph.evidence.slice(0, ANSWER_MAX_EVIDENCE);
    const allowed = new Set([
      ...userNumbers,
      ...cited.flatMap((e) => numericTokens(e.quote)),
      ...cited.flatMap((e) => numericTokens(byId.get(e.item)?.title ?? "")),
    ]);
    const unevidencedNumbers =
      problem === "unevidenced_number"
        ? paragraph.text
            .split(/\s+/)
            .flatMap((word) => (/\d/.test(word) ? numericTokens(word) : []))
            .filter((token) => !allowed.has(token))
        : [];
    return { paragraph, problem, unevidencedNumbers };
  });
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
