/**
 * Degerlendirme metrikleri (Faz 1A). Saf fonksiyonlar: veritabani, ag ya da
 * model cagrisi yok; ayni girdi her zaman ayni sonucu verir.
 *
 * Kullanim yerleri: arama (P@5, NDCG@10, sifir sonuc), niyet analizi
 * (precision/recall/macro-F1), eslestirme (yanlis eslestirme orani) ve
 * regresyon karsilastirmasi (`compareRuns`).
 */

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

/** 0/0 durumunda 0 doner: olculemeyen sey iyi sayilmaz. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function precisionRecallF1({ tp, fp, fn }: Confusion): Prf {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { precision, recall, f1: ratio(2 * precision * recall, precision + recall) };
}

/** Yanlis eslestirme orani: gercekte farkli olan ciftlerin "ayni" sayilma orani (FP / (FP + TN)). */
export function falseMatchRate({ fp, tn }: Confusion): number {
  return ratio(fp, fp + tn);
}

export interface LabeledPrediction<L extends string = string> {
  expected: L;
  predicted: L;
}

export interface MulticlassReport<L extends string = string> {
  total: number;
  accuracy: number;
  perClass: Record<L, Prf & { support: number }>;
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
}

/**
 * Cok sinifli rapor. Macro ortalamalar, destegi (support) en az bir olan
 * siniflar uzerinden alinir; hic gorulmeyen bir sinif ortalamayi yapay dusurmez.
 */
export function multiclassReport<L extends string>(
  items: readonly LabeledPrediction<L>[],
  labels?: readonly L[],
): MulticlassReport<L> {
  const classes = [...(labels ?? new Set(items.flatMap((i) => [i.expected, i.predicted])))];
  const perClass = {} as MulticlassReport<L>["perClass"];
  for (const label of classes) {
    const tp = items.filter((i) => i.expected === label && i.predicted === label).length;
    const fp = items.filter((i) => i.expected !== label && i.predicted === label).length;
    const fn = items.filter((i) => i.expected === label && i.predicted !== label).length;
    perClass[label] = {
      ...precisionRecallF1({ tp, fp, fn, tn: items.length - tp - fp - fn }),
      support: tp + fn,
    };
  }
  const scored = classes.filter((label) => perClass[label].support > 0);
  const average = (pick: (p: Prf) => number) =>
    ratio(
      scored.reduce((sum, label) => sum + pick(perClass[label]), 0),
      scored.length,
    );
  return {
    total: items.length,
    accuracy: ratio(items.filter((i) => i.expected === i.predicted).length, items.length),
    perClass,
    macroPrecision: average((p) => p.precision),
    macroRecall: average((p) => p.recall),
    macroF1: average((p) => p.f1),
  };
}

/** Precision@K: ilk K sonucun kesri. Liste K'dan kisaysa payda yine K (eksik sonuc ceza). */
export function precisionAtK(relevance: readonly number[], k: number): number {
  const hits = relevance.slice(0, k).filter((r) => r > 0).length;
  return ratio(hits, k);
}

function dcg(gains: readonly number[], k: number): number {
  return gains
    .slice(0, k)
    .reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0);
}

/**
 * NDCG@K. `relevance`: siralanmis sonuclarin kademeli ilgisi (0 = ilgisiz).
 * `idealPool`: katalogdaki bilinen ilgili urunlerin ilgi kademeleri; verilirse
 * ideal sira bundan kurulur (bilinen ilgili urun kacirildiysa skor duser).
 * Verilmezse ideal, dondurulen sonuclarin en iyi siralamasidir.
 */
export function ndcgAtK(
  relevance: readonly number[],
  k: number,
  idealPool?: readonly number[],
): number {
  const ideal = [...(idealPool ?? relevance)].sort((a, b) => b - a);
  return ratio(dcg(relevance, k), dcg(ideal, k));
}

/** Sifir sonuc orani: bos donen sorgularin kesri. */
export function zeroResultRate(resultCounts: readonly number[]): number {
  return ratio(resultCounts.filter((n) => n === 0).length, resultCounts.length);
}

export function mean(values: readonly number[]): number {
  return ratio(
    values.reduce((a, b) => a + b, 0),
    values.length,
  );
}

export type Direction = "higher" | "lower";

export interface MetricChange {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  regressed: boolean;
}

/**
 * Iki kosuyu karsilastirir. `directions` her metrigin iyi yonunu soyler
 * (precision icin "higher", yanlis eslestirme orani icin "lower").
 * `tolerance` kadar kotulesme regresyon sayilmaz (gurultu payi).
 * Yalniz iki kosuda da bulunan metrikler karsilastirilir.
 */
export function compareRuns(
  baseline: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
  directions: Readonly<Record<string, Direction>>,
  tolerance = 0,
): MetricChange[] {
  return Object.keys(directions)
    .filter((metric) => metric in baseline && metric in current)
    .map((metric) => {
      const before = baseline[metric] as number;
      const after = current[metric] as number;
      const delta = after - before;
      const worse = directions[metric] === "higher" ? -delta : delta;
      return {
        metric,
        baseline: before,
        current: after,
        delta,
        regressed: worse > tolerance + 1e-12,
      };
    });
}
