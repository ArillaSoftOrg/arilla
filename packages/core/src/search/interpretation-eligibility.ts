/**
 * Model yorumuna (docs/decisions/0059) gidebilecek sorgu adayi mi. Saf ve
 * deterministik; saglayicidan bagimsiz.
 *
 * Kaynak yalnizca toplu gunluk ozet (`search_query_day`; kullanici, oturum
 * veya cihaz tanimlayicisi icermez): kullanici, oturum, IP ya da
 * `user_activity_event` OKUNMAZ. Metin ANONIM DEGILDIR: serbest metin bir
 * kisiyi belirleyebilecek bilgi icerebilir; suzgecler riski azaltir, garanti
 * etmez (dolayli anlatim, yazim hatasi, listede olmayan terim gecebilir). Burada ek olarak modele
 * gidecek metin icin daha sikı suzgec uygulanir:
 *
 * - en az `INTERPRETATION_MIN_OCCURRENCES` kez aranmis olmali VE en az
 *   `INTERPRETATION_MIN_DISTINCT_DAYS` FARKLI gunde gorulmus olmali. Tek bir
 *   kisinin ayni gun ayni sorguyu tekrarlamasi esigi tek basina asamaz.
 *   Kimlik eklenmez: gun sayisi `search_query_day`'in (gun, sorgu) birincil
 *   anahtarindan gelir. Sinir: ayni kisi uc farkli gunde ararsa esik yine
 *   asilir; bu bir tekrar sinyalidir, farkli kisi sayisinin kaniti degildir;
 * - yalnizca normalize sorgu (normalize edilmemis metin reddedilir);
 * - `isRecordableQuery`: e-posta, URL, telefon, adres, 7+ haneli rakam;
 * - ek olarak: toplam 9+ rakam (bosluklu kimlik/IBAN), harf+rakam karisik
 *   uzun parca (16+), uzun onaltilik dizi, bilinen anahtar onekleri
 *   (`sk-`, `eyj…` JWT), `anahtar=deger` bicimi;
 * - ozel nitelikli kisisel veri baglami (KVKK m.6): saglik, gebelik,
 *   engellilik/inkontinans, din/mezhep kimligi, siyasi baglilik, cinsel
 *   hayat/yonelim, genetik/biyometrik, ceza mahkumiyeti, sendika. Kucuk ve
 *   denetlenebilir bir kok listesi (`SENSITIVE_PATTERNS`); deterministik,
 *   model kullanilmaz.
 *
 * Yanlis pozitif kabul edilebilir (bir sorgu yorumlanmaz); yanlis negatif
 * kabul edilemez (kisisel veri ya da sir modele gider).
 */
import { normalizeQueryText } from "./normalize.ts";
import { isRecordableQuery } from "./quality.ts";

export const INTERPRETATION_MIN_OCCURRENCES = 3;
/** En az bu kadar farkli gunde gorulmus olmali (pencere: toplu isin 30 gunu). */
export const INTERPRETATION_MIN_DISTINCT_DAYS = 3;
export const INTERPRETATION_QUERY_MIN_LENGTH = 2;
export const INTERPRETATION_QUERY_MAX_LENGTH = 120;

/** Toplam rakam sayisi: "123 456 789 01" gibi bolunmus kimlik numaralari. */
const MAX_TOTAL_DIGITS = 8;
/** Harf ve rakam iceren uzun parca (16+): token, sifre. "iphone15promax" (14) gecer. */
const MIXED_TOKEN = /^(?=[^\s]*\p{L})(?=[^\s]*\d)[^\s]{16,}$/u;
const HEX_RUN = /[0-9a-f]{16,}/u;
/** Ayracli bilinen onekler (`sk-…`, `ghp_…`, `xoxb-…`) ve Google anahtari (`aiza…`). Ayrac sart: "skechers" degil. */
const KEY_PREFIX =
  /(?:^|\s)(?:(?:sk|pk|rk|ghp|gho|xox[abp])[-_][a-z0-9_-]{6,}|aiza[a-z0-9_-]{20,})/iu;
const JWT_LIKE = /(?:^|\s)eyj[a-z0-9_-]{8,}/iu;
/** `anahtar=deger` bicimi. `\b` ASCII disi harfte calismaz; harf siniri elle. */
const KEY_VALUE_SECRET =
  /(?:^|[^\p{L}\p{N}])(?:password|parola|sifre|şifre|passwd|pwd|token|secret|api[\s_-]?key|anahtar|bearer)\s*[=:]/iu;

/**
 * KVKK m.6 ozel nitelikli veri baglami. Eslesme, Turkce harfleri ASCII'ye
 * katlanmis metinde yapilir ("şeker" ve "seker" ayni). Kok eslesmesi kelime
 * BASINDAN baslar ve Turkce ekleri kapsar ("hamile" -> "hamileyim"); kimlik
 * ve siyasi parti adlari yalnizca TAM kelime olarak eslesir.
 *
 * Bilerek temkinli: yanlis pozitif kabul edilir (ornegin "hamile pantolonu",
 * "biyometrik kilit", "cinsel saglik urunu" de yorumlanmaz; bu sorgular
 * bugunku deterministik aramayla aynen calisir). Yanlis negatif mumkundur:
 * liste kapsamli degildir, yazim hatasi ya da dolayli anlatim kacabilir;
 * irk/etnik koken ve kilik-kiyafet acik yanlis pozitif riski nedeniyle
 * listede yoktur. Liste genisletilirken bu dosya ve testleri birlikte guncellenir.
 */
export type SensitiveCategory =
  | "health"
  | "pregnancy"
  | "disability"
  | "religion"
  | "political"
  | "sexual"
  | "genetic_biometric"
  | "criminal"
  | "union";

const WORD_START = "(?:^|[^a-z0-9])";
const WORD_END = "(?=$|[^a-z0-9])";
const stems = (...items: string[]) => new RegExp(`${WORD_START}(?:${items.join("|")})`, "u");
const words = (...items: string[]) =>
  new RegExp(`${WORD_START}(?:${items.join("|")})${WORD_END}`, "u");

export const SENSITIVE_PATTERNS: readonly { category: SensitiveCategory; pattern: RegExp }[] = [
  {
    category: "health",
    pattern: stems(
      "hastalig",
      "hastasi",
      "hastalar",
      "teshis",
      "tedavi",
      "kanser",
      "tumor",
      "diyabet",
      "kemoterapi",
      "hepatit",
      "epilepsi",
      "depresyon",
      "sizofreni",
      "bipolar",
      "alzheimer",
      "parkinson",
      "otizm",
      "demans",
    ),
  },
  { category: "health", pattern: words("hiv", "aids") },
  {
    category: "pregnancy",
    pattern: stems("hamile", "gebe", "dusuk yap", "kisirlik", "tup bebek"),
  },
  {
    category: "disability",
    pattern: stems("inkontinans", "idrar kacir", "yetiskin bez", "hasta bez", "engelli"),
  },
  {
    category: "religion",
    pattern: words(
      "alevi",
      "aleviler",
      "sunni",
      "hristiyan",
      "hristiyanlar",
      "yahudi",
      "yahudiler",
      "musevi",
      "ateist",
      "dinim",
      "mezhebim",
      "inancim",
    ),
  },
  {
    category: "political",
    pattern: words("akp", "chp", "mhp", "hdp", "dem parti", "iyi parti", "partili", "siyasi gorus"),
  },
  {
    category: "sexual",
    pattern: stems(
      "escinsel",
      "lezbiyen",
      "biseksuel",
      "transseksuel",
      "transgender",
      "lgbt",
      "cinsel",
      "erotik",
    ),
  },
  { category: "sexual", pattern: words("seks", "gay") },
  { category: "genetic_biometric", pattern: stems("genetik", "biyometri") },
  { category: "genetic_biometric", pattern: words("dna") },
  { category: "criminal", pattern: stems("sabika", "mahkumiyet") },
  { category: "union", pattern: stems("sendika") },
];

const ASCII_FOLD: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  i̇: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

function asciiFold(text: string): string {
  return text.replace(/[çğıöşüâîû]|i̇/gu, (ch) => ASCII_FOLD[ch] ?? ch);
}

/** Ozel nitelikli veri baglami varsa kategorisi; yoksa `null`. Saf ve deterministik. */
export function sensitiveCategory(queryNorm: string): SensitiveCategory | null {
  const folded = asciiFold(queryNorm.toLocaleLowerCase("tr-TR"));
  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(folded)) return category;
  }
  return null;
}

export type IneligibleReason =
  | "too_few"
  | "too_few_days"
  | "sensitive"
  | "not_normalized"
  | "length"
  | "personal_data"
  | "id_like"
  | "secret_like";

export interface EligibilityInput {
  queryNorm: unknown;
  occurrences: unknown;
  /** Pencere icinde sorgunun goruldugu farkli gun sayisi. */
  distinctDays: unknown;
}

export function interpretationIneligibility(input: EligibilityInput): IneligibleReason | null {
  const { queryNorm, occurrences, distinctDays } = input;
  if (typeof occurrences !== "number" || !Number.isInteger(occurrences)) return "too_few";
  if (occurrences < INTERPRETATION_MIN_OCCURRENCES) return "too_few";
  if (typeof distinctDays !== "number" || !Number.isInteger(distinctDays)) return "too_few_days";
  if (distinctDays < INTERPRETATION_MIN_DISTINCT_DAYS) return "too_few_days";
  if (typeof queryNorm !== "string" || queryNorm !== normalizeQueryText(queryNorm)) {
    return "not_normalized";
  }
  if (
    queryNorm.length < INTERPRETATION_QUERY_MIN_LENGTH ||
    queryNorm.length > INTERPRETATION_QUERY_MAX_LENGTH
  ) {
    return "length";
  }
  if (!isRecordableQuery(queryNorm)) return "personal_data";
  if ((queryNorm.match(/\d/gu)?.length ?? 0) > MAX_TOTAL_DIGITS) return "id_like";
  if (KEY_VALUE_SECRET.test(queryNorm) || KEY_PREFIX.test(queryNorm) || JWT_LIKE.test(queryNorm)) {
    return "secret_like";
  }
  for (const token of queryNorm.split(" ")) {
    if (MIXED_TOKEN.test(token) || HEX_RUN.test(token)) {
      return "secret_like";
    }
  }
  if (sensitiveCategory(queryNorm) !== null) return "sensitive";
  return null;
}

export function isEligibleForInterpretation(input: EligibilityInput): boolean {
  return interpretationIneligibility(input) === null;
}
