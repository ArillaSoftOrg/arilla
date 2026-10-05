/**
 * Model yorumuna (docs/decisions/0059) gidebilecek sorgu adayi mi. Saf ve
 * deterministik; saglayicidan bagimsiz.
 *
 * Kaynak yalnizca kimliksiz toplu ozet (`search_query_day`): kullanici,
 * oturum, IP ya da `user_activity_event` OKUNMAZ. Burada ek olarak modele
 * gidecek metin icin daha sikı suzgec uygulanir:
 *
 * - en az `INTERPRETATION_MIN_OCCURRENCES` kez aranmis olmali;
 * - yalnizca normalize sorgu (normalize edilmemis metin reddedilir);
 * - `isRecordableQuery`: e-posta, URL, telefon, adres, 7+ haneli rakam;
 * - ek olarak: toplam 9+ rakam (bosluklu kimlik/IBAN), harf+rakam karisik
 *   uzun parca (16+), uzun onaltilik dizi, bilinen anahtar onekleri
 *   (`sk-`, `eyj…` JWT), `anahtar=deger` bicimi.
 *
 * Yanlis pozitif kabul edilebilir (bir sorgu yorumlanmaz); yanlis negatif
 * kabul edilemez (kisisel veri ya da sir modele gider).
 */
import { normalizeQueryText } from "./normalize.ts";
import { isRecordableQuery } from "./quality.ts";

export const INTERPRETATION_MIN_OCCURRENCES = 3;
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

export type IneligibleReason =
  | "too_few"
  | "not_normalized"
  | "length"
  | "personal_data"
  | "id_like"
  | "secret_like";

export interface EligibilityInput {
  queryNorm: unknown;
  occurrences: unknown;
}

export function interpretationIneligibility(input: EligibilityInput): IneligibleReason | null {
  const { queryNorm, occurrences } = input;
  if (typeof occurrences !== "number" || !Number.isInteger(occurrences)) return "too_few";
  if (occurrences < INTERPRETATION_MIN_OCCURRENCES) return "too_few";
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
  return null;
}

export function isEligibleForInterpretation(input: EligibilityInput): boolean {
  return interpretationIneligibility(input) === null;
}
