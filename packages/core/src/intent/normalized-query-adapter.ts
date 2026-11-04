/**
 * Normalizasyon sozlesmesinin niyet katmanindaki uyum katmani (0171 §6.2).
 *
 * Ortak tipin SAHIBI normalizasyon isidir: `search/normalized-query.ts`
 * (karar 0172). Niyet katmani tipi ve `NORM_VERSION`'i oradan alir; ikinci bir
 * tanim tutulmaz. Bu dosya yazim duzeltmez ve rol/niyet uretmez.
 *
 * Davranis garantileri (normalizasyon tarafinin taahhudu; dogrulayici yine de
 * bagimsiz kontrol eder): `span` HAM metne gore; `preservesCodes` dogru;
 * `norm` davranisi degisince `normVersion` degisir.
 */

import { normalizeQueryText, tokenizeWithOffsets } from "../search/normalize.ts";
import { type Correction, NORM_VERSION, type NormalizedQuery } from "../search/normalized-query.ts";

export { NORM_VERSION };

/** Eski adlar; ortak tiple ozdes. */
export type CorrectionLike = Correction;
export type NormalizedQueryLike = NormalizedQuery;

/**
 * Normalizasyon katmani yokken kullanilan karsilik: duzeltme yok,
 * `corrected = raw`. Faz 1 ve 2 bununla bloklanmadan calisir.
 */
export function fromRawQuery(raw: string): NormalizedQueryLike {
  return {
    raw,
    norm: normalizeQueryText(raw),
    normVersion: NORM_VERSION,
    corrected: raw,
    normalizerVersion: "none",
    tokens: tokenizeWithOffsets(raw).map((token) => ({
      text: token.value,
      span: [token.start, token.end] as const,
    })),
    corrections: [],
  };
}
