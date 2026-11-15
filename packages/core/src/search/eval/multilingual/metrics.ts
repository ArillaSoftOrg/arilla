/**
 * Cok dilli olcum: sorgu dili x belge dili cifti kirilimiyla nDCG@k ve P@k.
 *
 * Yalnizca `label_source = "human"` kayitlar kullanilir; `ai_preliminary_label` hicbir yerde okunmaz.
 * Etiketsiz (havuzda olmayan) belge ilgisiz sayilir; `judgedFraction` bunu gorunur kilar.
 * Ideal siralamasi 0 olan (insan etiketine gore ilgili urunu olmayan) sorgu ortalamaya girmez,
 * `skipped.noRelevant` olarak sayilir (eval-score.ts ile ayni kural).
 */
import { type CandidateItem, humanLabeled, languagePair } from "./schema.ts";

export interface RankedRun {
  system: string;
  query_id: string;
  /** Sira korunur, en iyisi basta. */
  doc_ids: readonly string[];
}

export interface MetricOptions {
  k?: number;
  /** P@k icin "ilgili" esigi (varsayilan 2). */
  relevantMin?: number;
}

export interface Aggregate {
  queries: number;
  ndcg: number;
  precision: number;
  /** Ilk k icinde insan etiketi olan belge orani (ortalama). */
  judgedFraction: number;
}

export interface SystemReport {
  system: string;
  overall: Aggregate;
  byQueryLang: Record<string, Aggregate>;
  /** Anahtar `query_lang>doc_lang`. */
  byPair: Record<string, Aggregate>;
  skipped: { noHumanLabels: number; noRelevant: number };
}

function dcg(gains: readonly number[]): number {
  return gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0);
}

interface Sample {
  ndcg: number;
  precision: number;
  judged: number;
}

function score(
  ranked: readonly string[],
  labels: ReadonlyMap<string, number>,
  k: number,
  relevantMin: number,
): Sample | "noRelevant" {
  const ideal = dcg([...labels.values()].sort((a, b) => b - a).slice(0, k));
  if (ideal === 0) return "noRelevant";
  const top = ranked.slice(0, k);
  const gains = top.map((id) => labels.get(id) ?? 0);
  return {
    ndcg: dcg(gains) / ideal,
    precision: gains.filter((g) => g >= relevantMin).length / k,
    judged: top.filter((id) => labels.has(id)).length / k,
  };
}

function aggregate(samples: readonly Sample[]): Aggregate {
  const mean = (pick: (s: Sample) => number) =>
    samples.length === 0
      ? 0
      : Math.round((samples.reduce((sum, s) => sum + pick(s), 0) / samples.length) * 1000) / 1000;
  return {
    queries: samples.length,
    ndcg: mean((s) => s.ndcg),
    precision: mean((s) => s.precision),
    judgedFraction: mean((s) => s.judged),
  };
}

export function evaluateMultilingual(
  items: readonly CandidateItem[],
  runs: readonly RankedRun[],
  options: MetricOptions = {},
): SystemReport[] {
  const k = options.k ?? 10;
  const relevantMin = options.relevantMin ?? 2;
  // Tek giris: insan etiketi. Baska kaynak buraya ulasamaz.
  const human = humanLabeled(items);
  const labelsByQuery = new Map<string, Map<string, number>>();
  const queryLang = new Map<string, string>();
  const docLang = new Map<string, string>();
  for (const item of items) docLang.set(item.doc_id, item.doc_lang);
  for (const item of human) {
    const map = labelsByQuery.get(item.query_id) ?? new Map<string, number>();
    map.set(item.doc_id, item.label as number);
    labelsByQuery.set(item.query_id, map);
    queryLang.set(item.query_id, item.query_lang);
  }
  for (const item of items) queryLang.set(item.query_id, item.query_lang);

  const systems = [...new Set(runs.map((run) => run.system))].sort();
  return systems.map((system) => {
    const overall: Sample[] = [];
    const byQueryLang = new Map<string, Sample[]>();
    const byPair = new Map<string, Sample[]>();
    const skipped = { noHumanLabels: 0, noRelevant: 0 };
    for (const run of runs.filter((r) => r.system === system)) {
      const labels = labelsByQuery.get(run.query_id);
      const qLang = queryLang.get(run.query_id);
      if (!labels || labels.size === 0 || !qLang) {
        skipped.noHumanLabels += 1;
        continue;
      }
      const whole = score(run.doc_ids, labels, k, relevantMin);
      if (whole === "noRelevant") {
        skipped.noRelevant += 1;
      } else {
        overall.push(whole);
        byQueryLang.set(qLang, [...(byQueryLang.get(qLang) ?? []), whole]);
      }
      // Dil cifti kirilimi: sirayi koruyarak yalniz o dildeki belgeler; ideal de o dilin etiketlerinden.
      const docLangs = new Set([...labels.keys()].map((id) => docLang.get(id) ?? "und"));
      for (const dl of docLangs) {
        const sub = new Map([...labels].filter(([id]) => (docLang.get(id) ?? "und") === dl));
        const ranked = run.doc_ids.filter((id) => (docLang.get(id) ?? "und") === dl);
        const part = score(ranked, sub, k, relevantMin);
        if (part === "noRelevant") continue;
        const key = languagePair(qLang, dl);
        byPair.set(key, [...(byPair.get(key) ?? []), part]);
      }
    }
    return {
      system,
      overall: aggregate(overall),
      byQueryLang: Object.fromEntries(
        [...byQueryLang].map(([key, value]) => [key, aggregate(value)]),
      ),
      byPair: Object.fromEntries([...byPair].map(([key, value]) => [key, aggregate(value)])),
      skipped,
    };
  });
}
