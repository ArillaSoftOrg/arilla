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

/**
 * Modele giden tek ürün gerçeği. Fiyat TL tam sayı; yoksa `null`.
 *
 * Yurt dışı (ör. AliExpress) tekliflerde `price_try` kartta gösterilen KURLA ÇEVRİLMİŞ yaklaşık
 * tutardır (karar 0129/0132): `price_approx: true` ile işaretlenir ve `price_date` yalnız kur tarihi
 * biliniyorsa (YYYY-MM-DD) dolar. Kesin TRY fiyatta ikisi de yoktur (alan hiç eklenmez).
 */
export interface ResultFact {
  id: string;
  title: string;
  brand: string | null;
  store: string | null;
  price_try: number | null;
  offer_count: number | null;
  price_approx?: true;
  price_date?: string;
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
  /**
   * Yurt dışı teklif (karar 0129): `minPrice` kurla çevrilmiş YAKLAŞIK TL'dir; kur yoksa `minPrice`
   * null olur ve fiyat verilmez. `fxDate` kur bülteni tarihidir.
   */
  foreignPrice?: { fxDate?: string | null } | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Katalog kartlarından ürün gerçekleri (en çok 8). Fiyat kartta gösterilenle AYNIDIR: kesin TRY
 * fiyat olduğu gibi, yurt dışı teklifte kurla çevrilmiş yaklaşık TL `price_approx` (+ biliniyorsa
 * `price_date`) ile. Fiyatı olmayan ürün çıkarılmaz; `price_try` null kalır.
 */
export function toResultFacts(items: readonly FactSourceItem[]): ResultFact[] {
  return items.slice(0, RESULT_FACT_LIMIT).map((item, index) => {
    const priced = item.minPrice !== null && item.minPrice > 0;
    const foreign = priced && item.foreignPrice ? item.foreignPrice : null;
    const date = foreign?.fxDate;
    return {
      id: `p${index + 1}`,
      title: item.title.slice(0, 160),
      brand: item.brandName?.trim() || null,
      store: item.merchantName?.trim() || null,
      price_try: priced ? Math.round((item.minPrice as number) / 100) : null,
      offer_count: item.offerCount ?? null,
      ...(foreign ? { price_approx: true as const } : {}),
      ...(typeof date === "string" && ISO_DATE.test(date) ? { price_date: date } : {}),
    };
  });
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
  /(?<![\p{L}\d])(?:kalite\p{L}*|performans\p{L}*|h[ıi]zl[ıi]\p{L}*|yava[sş]\p{L}*|dayan[ıi]kl[ıi]\p{L}*|dayan[ıi]m\p{L}*|garanti\p{L}*|uyumlu\p{L}*|g[uü][cç]l[uü]\p{L}*|teknolojik\p{L}*|imkan\p{L}*|tasarlan\p{L}*|y[oö]nelik|ama[cç]l[ıi]|kullan[ıi]ma uygun|ideal\p{L}*|geli[sş]mi[sş]\p{L}*|kapsaml[ıi]\p{L}*|pratik|hitap|geni[sş] (?:[oö]zellik|depolama|kapasite|alan)\p{L}*|[oö]zellik set\p{L}*|kargo\p{L}*|vergi\p{L}*|kdv|g[uü]mr[uü]k\p{L}*|toplam (?:maliyet|tutar|bedel)\p{L}*|[uü]cretsiz\p{L}*)(?![\p{L}\d])/iu;
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

/** Yaklaşık (kurla çevrilmiş) tutarı veren paragrafın taşıması gereken ifade. */
const APPROX_WORD_RE =
  /(?<![\p{L}\d])(?:yakla[sş][ıi]k\p{L}*|civar\p{L}*|tahmini|kur\p{L}* [cç]evril\p{L}*)(?![\p{L}\d])/iu;

/**
 * Kısmi kapsam bildiren sözcükler: "diğer ürünlerin başlığında X yok" doğru olabilir; yanlış
 * yokluk denetimi yalnız TÜM ürünler için "yok" diyen cümlelere uygulanır.
 */
const PARTIAL_SCOPE_RE =
  /(?<![\p{L}\d])(?:di[gğ]er\p{L}*|baz[ıi]\p{L}*|yaln[ıi]z\p{L}*|sadece|d[ıi][sş][ıi]nda\p{L}*|haricinde|geri kalan\p{L}*)(?![\p{L}\d])/iu;

/**
 * Başlıkta Türkçe ve İngilizce yazılabilen malzeme terimleri (küçük, genel bir sözlük; Faz 8 yapılandırılmış
 * öznitelikleri gelene kadar). Her satır aynı malzemenin takma adlarıdır (katlanmış, kök).
 */
const MATERIAL_ALIASES: readonly (readonly string[])[] = [
  ["pamuk", "cotton"],
  ["keten", "linen"],
  ["silikon", "silicone", "tpr"],
  ["celik", "steel", "stainless", "paslanmaz"],
  ["deri", "leather"],
  ["naylon", "nylon"],
  ["polyester"],
  ["plastik", "plastic"],
  ["ahsap", "wood", "wooden"],
  ["cam", "glass"],
  ["aluminyum", "aluminum", "aluminium", "alüminyum"],
];

function foldedWords(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\d]+/u)
    .filter(Boolean);
}

/**
 * "Hiçbir ürünün başlığında X yok" iken X bir başlıkta VARSA cevap yanlıştır (insan denetimi: "Cotton"
 * varken "pamuklu yok", "iPhone … 16" varken "iPhone 16 ifadesi yok"). İki dar sinyal: (1) malzeme
 * sözlüğündeki bir terim, (2) iki+ haneli sayı (model/seri numarası). Kısmi kapsamlı cümleye uygulanmaz.
 */
function falseAbsence(text: string, facts: readonly ResultFact[]): boolean {
  if (facts.length === 0) return false;
  const titleWords = facts.map((fact) => foldedWords(fact.title));
  const titleTokens = facts.map((fact) => numericTokens(fact.title));
  for (const clause of text.split(/(?<=[.!?;])\s+/)) {
    if (!ABSENCE_RE.test(clause) || PARTIAL_SCOPE_RE.test(clause)) continue;
    const words = foldedWords(clause);
    for (const group of MATERIAL_ALIASES) {
      const mentioned = words.some((word) => group.some((alias) => word.startsWith(fold(alias))));
      if (!mentioned) continue;
      const inTitle = titleWords.some((tw) =>
        tw.some((word) => group.some((alias) => word.startsWith(fold(alias)))),
      );
      if (inTitle) return true;
    }
    // Yalnız başlı başına duran sayı ("iPhone 16"); ürün adının parçası ("LP40", "520BT") sayılmaz.
    for (const word of clause.split(/\s+/)) {
      const token = word.replace(/[.,;:!?'")(]+$/g, "");
      if (/^\d{2,}$/.test(token) && titleTokens.some((tokens) => tokens.includes(token)))
        return true;
    }
  }
  return false;
}

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
  allFacts: readonly ResultFact[] = [],
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
  // Kurla çevrilmiş (yaklaşık) fiyat KESİN fiyat gibi sunulamaz: tutarı veren paragraf bunun yaklaşık
  // olduğunu söylemelidir. Kargo/vergi/toplam maliyet ayrıca `forbiddenClaim` ile yasaktır.
  const citesApproxPrice = evidence.some(
    (e) => e.field === "price" && facts.get(e.item)?.price_approx === true,
  );
  if (citesApproxPrice && !APPROX_WORD_RE.test(text)) return "approx_price_unlabelled";
  if (falseAbsence(text, allFacts)) return "false_absence";
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
      // Fiyat tarihi yalnız VERİLDİYSE söylenebilir (uydurma tarih sayı denetiminden geçemez).
      return numericTokens(
        `${fact?.title ?? ""} ${fact?.brand ?? ""} ${fact?.store ?? ""} ${fact?.price_date ?? ""}`,
      );
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
    const problem = paragraphProblem(paragraph, byId, userNumbers, facts);
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
    const problem = paragraphProblem(paragraph, byId, userNumbers, facts);
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
  // Kurla çevrilmiş tutarlar yaklaşıktır; özet bunu söylemeden fiyat aralığı vermez.
  const approx = facts.some((fact) => fact.price_approx === true && fact.price_try !== null)
    ? " Yurt dışı mağaza fiyatları kurla çevrilmiş yaklaşık TL tutarlarıdır."
    : "";
  return `Ürünleri karşılaştırmalı yorumlayamadım; doğrulanmış verilere göre özet: ${summary.sentences.join(" ")}${approx}`;
}
