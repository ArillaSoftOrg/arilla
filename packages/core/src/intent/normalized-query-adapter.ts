/**
 * Normalizasyon sozlesmesinin niyet katmanindaki uyum katmani (0171 §6.2).
 *
 * Ortak tipin SAHIBI normalizasyon isidir (`search/normalized-query.ts`,
 * karar 0172). O dosya birlesene kadar niyet katmani ihtiyac duydugu alt
 * kumeyi burada YAPISAL olarak tanimlar; gercek tip geldiginde bu arayuzu
 * karsilar (alanlar ayni, ek alanlar isteğe bagli). Bu dosya yazim
 * duzeltmez ve rol/niyet uretmez.
 *
 * Davranis garantileri (normalizasyon tarafinin taahhudu, burada dogrulanir):
 * - `span` HAM metne gore [baslangic, bitis) karakter konumudur;
 * - `preservesCodes` dogrudur (dogrulayici yine de bagimsiz kontrol eder);
 * - `norm` davranisi degisince `normVersion` degisir.
 */
import { normalizeQueryText, tokenizeWithOffsets } from "../search/normalize.ts";

/** `normalizeQueryText` davranisinin surumu. O fonksiyon degisirse artar. */
export const NORM_VERSION = "1";

export interface CorrectionLike {
  from: string;
  to: string;
  span: readonly [number, number];
  kind: "spelling" | "brand" | "model" | "unit";
  confidence: number;
  preservesCodes: boolean;
}

export interface NormalizedQueryLike {
  raw: string;
  norm: string;
  normVersion: string;
  corrected: string;
  normalizerVersion: string;
  tokens: readonly { text: string; span: readonly [number, number] }[];
  corrections: readonly CorrectionLike[];
}

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
