/**
 * Ortak sorgu normalizasyonu sozlesmesi (karar 0172; tuketici: niyet katmani, karar 0171).
 *
 * Tek veri sozlesmesi: normalizasyon (`search/spelling/`) bunu URETIR, niyet katmani
 * (`intent/`) ve arama bunu TUKETIR. Ikinci bir sozlesme yazilmaz; degisiklik yalnizca
 * bu dosyada ve geriye uyumlu (istege bagli alan ekleyerek) yapilir.
 *
 * Gorev ayrimi:
 * - Normalizasyon yazim duzeltme, fonetik esleme, Turkce ek cozumleme ve marka/model adayi
 *   uretir. Urun niyeti ve rol (ana urun / aksesuar / parca) KARARI vermez; yalnizca
 *   baglayici olmayan `hints` uretebilir.
 * - Niyet katmani yazim duzeltmez. Kesin niyet ve rol kararinin tek kaynagi odur.
 *
 * Garantiler (uretici tarafindan saglanir, tuketici bagimsiz olarak dogrulayabilir):
 * - `raw` kullanicinin degistirilmemis metnidir; tum `span` degerleri `raw` uzerindedir
 *   (`[baslangic, bitis)`, UTF-16 kod birimi).
 * - `norm` = `normalizeQueryText(raw)`. Onbellek kimligidir (`query_resolution`,
 *   `query_interpretation`); `corrected` HICBIR onbellekte anahtar olmaz.
 * - `normVersion` yalnizca `normalizeQueryText` davranisi degisince artar.
 * - `normalizerVersion` duzeltme kurallari ya da sozcuk dagarcigi degisince degisir.
 *   Normalizasyon ciktisi saklanmaz; saklayan bir tuketici bu surumu anahtara katmalidir.
 * - `preservesCodes` dogru hesaplanir: `from` ve `to` icindeki rakamli/alfanumerik
 *   dizilerin kumesi aynidir ("s24" -> "s23" asla uretilmez).
 * - Duzeltme yoksa `corrected === raw` ve `corrections` bostur.
 * - Duzeltmeler acik kullanici beyani DEGILDIR: sert filtreye (H kipi) donusmez.
 */

/** `normalizeQueryText` davranis surumu. Fonksiyon degisirse artirilir. */
export const NORM_VERSION = "1";

export type CorrectionKind = "spelling" | "brand" | "model" | "unit";

export type CorrectionMethod = "suffix" | "phonetic" | "edit" | "lexicon";

export type VocabularySource = "brand" | "category" | "lexicon" | "seed";

export interface NormalizedToken {
  text: string;
  span: readonly [number, number];
  unit?: { value: number; unit: string };
}

export interface CorrectionAlternative {
  to: string;
  confidence: number;
}

export interface CorrectionEvidence {
  method: CorrectionMethod;
  source: VocabularySource;
  /** Katlanmis bicimler arasi Damerau-Levenshtein mesafesi (varsa). */
  distance?: number;
}

export interface Correction {
  /** `raw` icindeki ozgun metin; `raw.slice(span[0], span[1]) === from`. */
  from: string;
  to: string;
  span: readonly [number, number];
  kind: CorrectionKind;
  /** 0-1; normalizasyonun gelistirme kumesinde kalibre ettigi guven. */
  confidence: number;
  preservesCodes: boolean;
  /** Belirsizlikte en fazla 2 ek aday (en iyiden kotuye); `to` bunlara dahil degildir. */
  alternatives?: readonly CorrectionAlternative[];
  /** Duzeltmenin kaniti: hangi yontem ve hangi sozcuk kaynagi. */
  evidence?: CorrectionEvidence;
}

export type RoleCandidate = "main" | "accessory" | "part";

/** Baglayici OLMAYAN ipuclari; rol karari niyet katmanindadir. */
export interface NormalizationHints {
  headTypeCandidate?: string;
  roleCandidate?: RoleCandidate;
}

export interface NormalizedQuery {
  /** Degistirilmemis kullanici metni. */
  raw: string;
  /** `normalizeQueryText(raw)`; onbellek kimligi. */
  norm: string;
  normVersion: string;
  /** Duzeltmeleri uygulanmis arama metni (yoksa `raw`). */
  corrected: string;
  normalizerVersion: string;
  tokens: readonly NormalizedToken[];
  corrections: readonly Correction[];
  hints?: NormalizationHints;
}
