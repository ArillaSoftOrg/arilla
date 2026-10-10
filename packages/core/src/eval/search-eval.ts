/**
 * Arama degerlendirme ozeti (Faz 1A). Saf: `run-eval.ts`'in urettigi satirlari
 * (kayitli JSON de olabilir) metriklere cevirir. Veritabani gerektirmez, bu
 * yuzden iki kosu CI'da ya da yerelde cevrimdisi karsilastirilabilir.
 */
import {
  compareRuns,
  type Direction,
  type MetricChange,
  mean,
  ndcgAtK,
  precisionAtK,
  zeroResultRate,
} from "./metrics.ts";

/** `EvalRow`'un ozetin ihtiyac duydugu kesiti (DB tiplerine bagimli degil). */
export interface SearchEvalRow {
  q: string;
  absent: boolean;
  returned: number;
  relevance: readonly number[];
  relevantInCatalog: number;
  zeroResultCorrect: boolean | null;
  usedFallback: boolean;
}

export interface SearchSummary {
  queries: number;
  /** Katalogda karsiligi olan sorgular uzerinden. */
  scoredQueries: number;
  precisionAt5: number;
  ndcgAt10: number;
  /** Tum sorgularda bos donme orani (fallback oncesi degil, sonrasi). */
  zeroResultRate: number;
  /** Karsiligi olmayan ("absent") sorgularda dogru sekilde bos donme orani. */
  absentCorrectRate: number;
  /** Karsiligi olan sorgularda hic ilgili sonuc donmeyen sorgu orani. */
  missRate: number;
}

export function summarizeSearch(rows: readonly SearchEvalRow[]): SearchSummary {
  const scored = rows.filter((r) => r.zeroResultCorrect === null);
  const absent = rows.filter((r) => r.zeroResultCorrect !== null);
  return {
    queries: rows.length,
    scoredQueries: scored.length,
    precisionAt5: mean(scored.map((r) => precisionAtK(r.relevance, 5))),
    // Ideal sira katalogdaki ilgili urun sayisindan kurulur (en fazla 10).
    ndcgAt10: mean(
      scored.map((r) => ndcgAtK(r.relevance, 10, Array(Math.min(10, r.relevantInCatalog)).fill(1))),
    ),
    zeroResultRate: zeroResultRate(rows.map((r) => r.returned)),
    absentCorrectRate: mean(absent.map((r) => (r.zeroResultCorrect ? 1 : 0))),
    missRate: mean(scored.map((r) => (r.relevance.some((x) => x > 0) ? 0 : 1))),
  };
}

export const SEARCH_DIRECTIONS: Record<
  keyof Omit<SearchSummary, "queries" | "scoredQueries">,
  Direction
> = {
  precisionAt5: "higher",
  ndcgAt10: "higher",
  zeroResultRate: "lower",
  absentCorrectRate: "higher",
  missRate: "lower",
};

export function compareSearch(
  baseline: SearchSummary,
  current: SearchSummary,
  tolerance = 0.01,
): MetricChange[] {
  return compareRuns({ ...baseline }, { ...current }, SEARCH_DIRECTIONS, tolerance);
}
