/**
 * Turkce sorgu normalizasyonu (karar 0172). Tek giris: `normalizeQuery`.
 * Ciktisi ortak sozlesmedir (`../normalized-query.ts`); saklanmaz, her istekte hesaplanir.
 */

import { normalizeQueryText } from "../normalize.ts";
import { NORM_VERSION, type NormalizedQuery } from "../normalized-query.ts";
import { correctQuery } from "./correct.ts";
import type { Vocabulary } from "./vocabulary.ts";

/** Duzeltme kurallari surumu; kural, esik ya da ek/fonetik tablosu degisince artirilir. */
export const NORMALIZER_RULES_VERSION = "1";

export function normalizeQuery(raw: string, vocabulary: Vocabulary): NormalizedQuery {
  const { tokens, corrections, corrected } = correctQuery(raw, vocabulary);
  return {
    raw,
    norm: normalizeQueryText(raw),
    normVersion: NORM_VERSION,
    corrected,
    normalizerVersion: `${NORMALIZER_RULES_VERSION}+${vocabulary.version}`,
    tokens,
    corrections,
  };
}

export { type QueryNormalizationMode, queryNormalizationMode } from "./config.ts";
export { MIN_CONFIDENCE } from "./correct.ts";
export { phoneticForm, phoneticKey } from "./phonetic.ts";
export { renderSuffixed, suffixSplits } from "./suffixes.ts";
export {
  buildVocabulary,
  SEED_WORDS,
  type Vocabulary,
  type VocabularyInput,
} from "./vocabulary.ts";
