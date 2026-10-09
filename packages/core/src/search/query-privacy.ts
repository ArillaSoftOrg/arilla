/**
 * Kimlik ve sir benzeri sorgu metni. Saf ve deterministik; model ya da
 * veritabani kullanmaz. Iki yol paylasir:
 *
 * - `queryContentIneligibility` (modele giden metin, `query_resolution`)
 * - arama kalitesi ozeti (`search_query_day`, `quality.ts`)
 *
 * Kapsam bilerek dar: yalnizca rakam yogunlugu ve sir bicimleri. E-posta,
 * telefon, adres, URL `isRecordableQuery`'de; ozel nitelikli veri baglami
 * `interpretation-eligibility.ts`'de kalir.
 *
 * Yanlis pozitif kabul edilebilir (sorgu yazilmaz/yorumlanmaz); yanlis
 * negatif kabul edilemez (kimlik ya da sir saklanir).
 */

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

export type IdentifierOrSecretReason = "id_like" | "secret_like";

/** Normalize sorgu kimlik ya da sir benzeri mi; degilse `null`. */
export function identifierOrSecretReason(queryNorm: string): IdentifierOrSecretReason | null {
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
