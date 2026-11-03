/**
 * Normalizasyon degerlendirmesi (karar 0172). Saf: veri kumesi + dagarcik -> olcutler.
 *
 * Vaka sozlesmesi: `expect` = ham token -> kabul edilen hedefler (Turkce kucuk harf).
 * - Beklenen token beklenen hedeflerden birine duzeltilirse isabet.
 * - `expect`te olmayan tokena duzeltme ya da kabul edilmeyen hedef = yanlis duzeltme.
 * - Vaka dogru = tum beklenenler isabet ve hic yanlis duzeltme yok.
 */
import type { NormalizedQuery } from "../normalized-query.ts";
import { foldForMatch } from "../text-match.ts";
import { normalizeQuery } from "./index.ts";
import type { Vocabulary } from "./vocabulary.ts";

export interface NormalizationCase {
  id: string;
  category: string;
  query: string;
  expect: Record<string, readonly string[]>;
}

export interface CaseOutcome {
  id: string;
  category: string;
  query: string;
  corrected: string;
  correct: boolean;
  wrong: string[];
  missed: string[];
  /** Beklenen hedef `to`da degil ama alternatiflerde. */
  inAlternatives: string[];
  codesPreserved: boolean;
  brandsPreserved: boolean;
  micros: number;
}

export interface NormalizationReport {
  cases: number;
  /** Duzeltme bekleyen vakalarda vaka dogrulugu. */
  normalizationAccuracy: number;
  expectedCases: number;
  /** En az bir yanlis duzeltme iceren vaka orani (tum vakalar). */
  wrongCorrectionRate: number;
  /** "no_correct" kategorisinde yanlis duzeltme orani. */
  noCorrectWrongRate: number;
  /** Duzeltme beklemeyen vakalarda hic duzeltme uretilmeme orani. */
  unchangedRate: number;
  codePreservation: number;
  brandPreservation: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  byCategory: Record<string, { cases: number; correct: number; wrong: number }>;
  outcomes: CaseOutcome[];
}

function rawTokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function outcomeOf(
  item: NormalizationCase,
  result: NormalizedQuery,
  brandWords: ReadonlySet<string>,
  micros: number,
): CaseOutcome {
  const wrong: string[] = [];
  const missed: string[] = [];
  const inAlternatives: string[] = [];
  const produced = new Map(result.corrections.map((c) => [c.from, c]));
  for (const [token, accepted] of Object.entries(item.expect)) {
    const correction = produced.get(token);
    if (!correction) {
      missed.push(token);
      continue;
    }
    if (!accepted.includes(correction.to)) {
      wrong.push(`${token}->${correction.to}`);
      if (correction.alternatives?.some((alt) => accepted.includes(alt.to)))
        inAlternatives.push(token);
    }
  }
  for (const correction of result.corrections) {
    if (!(correction.from in item.expect)) wrong.push(`${correction.from}->${correction.to}`);
  }
  const correctedTokens = new Set(rawTokens(result.corrected).map((t) => foldForMatch(t)));
  const raw = rawTokens(item.query);
  const codesPreserved = raw
    .filter((t) => /\d/.test(t))
    .every((t) => correctedTokens.has(foldForMatch(t)));
  // Marka kimligi: katlanmis bicim degismemeli (yalniz Turkce karakter geri kazanimi serbest).
  const brandsPreserved = raw
    .filter((t) => brandWords.has(foldForMatch(t)))
    .every((t) =>
      result.corrections.every((c) => c.from !== t || foldForMatch(c.to) === foldForMatch(t)),
    );
  return {
    id: item.id,
    category: item.category,
    query: item.query,
    corrected: result.corrected,
    correct: wrong.length === 0 && missed.length === 0,
    wrong,
    missed,
    inAlternatives,
    codesPreserved,
    brandsPreserved,
    micros,
  };
}

export function evaluateNormalization(
  cases: readonly NormalizationCase[],
  vocabulary: Vocabulary,
  brands: readonly string[],
  options: { repeats?: number } = {},
): NormalizationReport {
  const repeats = options.repeats ?? 5;
  const brandWords = new Set(
    brands.flatMap((brand) =>
      rawTokens(brand.toLocaleLowerCase("tr-TR")).map((t) => foldForMatch(t)),
    ),
  );
  const outcomes = cases.map((item) => {
    normalizeQuery(item.query, vocabulary);
    const started = performance.now();
    let result = normalizeQuery(item.query, vocabulary);
    for (let i = 1; i < repeats; i += 1) result = normalizeQuery(item.query, vocabulary);
    const micros = ((performance.now() - started) / repeats) * 1000;
    return outcomeOf(item, result, brandWords, micros);
  });

  const expected = outcomes.filter(
    (_outcome, i) => Object.keys((cases[i] as NormalizationCase).expect).length > 0,
  );
  const unexpected = outcomes.filter(
    (_outcome, i) => Object.keys((cases[i] as NormalizationCase).expect).length === 0,
  );
  const noCorrect = outcomes.filter((o) => o.category === "no_correct");
  const byCategory: NormalizationReport["byCategory"] = {};
  for (const outcome of outcomes) {
    const bucket = byCategory[outcome.category] ?? { cases: 0, correct: 0, wrong: 0 };
    bucket.cases += 1;
    if (outcome.correct) bucket.correct += 1;
    if (outcome.wrong.length > 0) bucket.wrong += 1;
    byCategory[outcome.category] = bucket;
  }
  const latencies = outcomes.map((o) => o.micros / 1000).sort((a, b) => a - b);
  const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);
  return {
    cases: outcomes.length,
    normalizationAccuracy: ratio(expected.filter((o) => o.correct).length, expected.length),
    expectedCases: expected.length,
    wrongCorrectionRate: ratio(outcomes.filter((o) => o.wrong.length > 0).length, outcomes.length),
    noCorrectWrongRate: ratio(noCorrect.filter((o) => o.wrong.length > 0).length, noCorrect.length),
    unchangedRate: ratio(unexpected.filter((o) => o.wrong.length === 0).length, unexpected.length),
    codePreservation: ratio(outcomes.filter((o) => o.codesPreserved).length, outcomes.length),
    brandPreservation: ratio(outcomes.filter((o) => o.brandsPreserved).length, outcomes.length),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    byCategory,
    outcomes,
  };
}
