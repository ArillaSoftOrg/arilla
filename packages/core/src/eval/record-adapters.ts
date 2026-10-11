/**
 * Mevcut eval ciktilarini `RecordInput`'a cevirir (saf; DB/ag yok).
 * Gercek etiketli veri olmayan bilesen (gorsel benzerlik) icin adaptor YOKTUR:
 * metrik uydurulmaz.
 */
import banked from "../search/eval/bootstrap-queries.json" with { type: "json" };
import golden from "./datasets/intent-golden.json" with { type: "json" };
import type { IntentRow, IntentSummary } from "./intent-eval.ts";
import { intentStoredMetrics, searchStoredMetrics } from "./metric-keys.ts";
import type { RecordInput } from "./record.ts";
import { type SearchEvalRow, summarizeSearch } from "./search-eval.ts";
import { caseKey, datasetFingerprint, type EvalCaseInput } from "./store.ts";

/** Surum etiketi icerikten turer: veri seti degisince etiket de degisir. */
const versioned = (name: string, items: unknown) =>
  `${name}-${datasetFingerprint(items).slice(0, 8)}`;

export function intentRecord(
  rows: readonly IntentRow[],
  summary: IntentSummary,
  algorithmVersion: string,
): RecordInput {
  return {
    component: "gemini_intent",
    snapshot: {
      dataset: "intent",
      version: versioned("intent-golden", golden.cases),
      items: golden.cases,
      verifiedCount: golden.cases.length,
    },
    // Kural tabanli motor olculur; Gemini cagrilmaz (model surumu yok).
    algorithmVersion,
    metrics: intentStoredMetrics(summary),
    cases: rows.map(
      (r): EvalCaseInput => ({
        caseKey: caseKey("intent", r.query),
        outcome: r.failures.length === 0 ? "pass" : "fail",
        failureClass:
          r.failures.length === 0
            ? undefined
            : r.expectedAction !== r.predictedAction
              ? "wrong_action"
              : "wrong_detail",
      }),
    ),
  };
}

export interface MatchingReportJson {
  pairs: number;
  metrics: Record<string, number>;
  thresholds?: { queue: number; auto: number };
  errors: { case: string; expected_match: boolean }[];
}

export function matchingRecord(
  report: MatchingReportJson,
  pairsFixture: unknown,
  verifiedCount: number,
  algorithmVersion: string,
): RecordInput {
  return {
    component: "matching",
    snapshot: {
      dataset: "matching",
      version: versioned("matching-pairs", pairsFixture),
      items: pairsFixture,
      verifiedCount,
    },
    algorithmVersion,
    metrics: report.metrics,
    // Yalnizca hatali ciftler kaydedilir (gecenler eval_offline'da tutulmaz).
    cases: report.errors.map(
      (e): EvalCaseInput => ({
        caseKey: caseKey("matching", e.case),
        outcome: "fail",
        failureClass: e.expected_match ? "missed_match" : "false_match",
      }),
    ),
  };
}

export function searchRecord(
  rows: readonly (SearchEvalRow & { q: string })[],
  algorithmVersion: string,
): RecordInput {
  const queries = banked.queries;
  return {
    component: "search",
    snapshot: {
      dataset: "search",
      version: versioned("bootstrap-queries", queries),
      items: queries,
      verifiedCount: queries.length,
    },
    algorithmVersion,
    metrics: searchStoredMetrics(summarizeSearch(rows)),
    cases: rows.map((r): EvalCaseInput => {
      const hit = r.relevance.some((x) => x > 0);
      if (r.zeroResultCorrect === true) return { caseKey: caseKey("search", r.q), outcome: "pass" };
      if (r.zeroResultCorrect === false) {
        return { caseKey: caseKey("search", r.q), outcome: "fail", failureClass: "false_result" };
      }
      if (hit) return { caseKey: caseKey("search", r.q), outcome: "pass" };
      return {
        caseKey: caseKey("search", r.q),
        outcome: "fail",
        failureClass: r.returned === 0 ? "zero_result" : "low_rank",
      };
    }),
  };
}
