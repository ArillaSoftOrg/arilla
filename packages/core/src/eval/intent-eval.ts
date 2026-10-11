/**
 * Niyet/belirsizlik degerlendirmesi (Faz 1A). Deterministik: kural tabanli
 * `clarification` motorunu calistirir; Gemini ya da ag cagrisi yoktur.
 * (Gemini yorumlayicisinin cikti dogrulamasi `interpreter.test.ts`'te sahte
 * saglayici ile test edilir.)
 */
import { step } from "../clarification/engine.ts";
import { createInitialState } from "../clarification/state.ts";
import { TEST_CONTEXT } from "../clarification/test-fixtures.ts";
import golden from "./datasets/intent-golden.json" with { type: "json" };
import { type MulticlassReport, mean, multiclassReport } from "./metrics.ts";

export type IntentAction = "clarify" | "search";

export interface IntentCase {
  query: string;
  action: IntentAction;
  question?: string;
  notAsked?: readonly string[];
  facets?: Readonly<Record<string, string>>;
  domain?: string | null;
  budget?: { minKurus: number | null; maxKurus: number | null };
  label_source: string;
}

export interface IntentRow {
  query: string;
  expectedAction: IntentAction;
  predictedAction: IntentAction;
  /** Kontrol edilen her alt iddia icin gecti/kaldi; kaldiysa aciklama. */
  failures: string[];
}

export const INTENT_CASES: readonly IntentCase[] = golden.cases as IntentCase[];

export function evaluateIntentCase(testCase: IntentCase): IntentRow {
  const decision = step(createInitialState(), { type: "text", text: testCase.query }, TEST_CONTEXT);
  const failures: string[] = [];
  if (decision.action !== testCase.action) {
    failures.push(`action: beklenen ${testCase.action}, gelen ${decision.action}`);
  }
  if (testCase.action === "clarify" && decision.action === "clarify") {
    if (testCase.question && decision.question.id !== testCase.question) {
      failures.push(`soru: beklenen ${testCase.question}, gelen ${decision.question.id}`);
    }
  }
  if (decision.action === "clarify") {
    for (const id of testCase.notAsked ?? []) {
      if (decision.question.id === id) failures.push(`sorulmamaliydi: ${id}`);
    }
  }
  if (testCase.domain !== undefined && decision.state.domainId !== testCase.domain) {
    failures.push(`domain: beklenen ${testCase.domain}, gelen ${decision.state.domainId}`);
  }
  for (const [facetId, optionId] of Object.entries(testCase.facets ?? {})) {
    const got = decision.state.facets[facetId]?.optionId;
    if (got !== optionId) failures.push(`faset ${facetId}: beklenen ${optionId}, gelen ${got}`);
  }
  if (testCase.budget) {
    const { budget } = decision.state;
    if (
      budget?.minKurus !== testCase.budget.minKurus ||
      budget?.maxKurus !== testCase.budget.maxKurus
    ) {
      failures.push(
        `butce: beklenen ${JSON.stringify(testCase.budget)}, gelen ${JSON.stringify(budget)}`,
      );
    }
  }
  return {
    query: testCase.query,
    expectedAction: testCase.action,
    predictedAction: decision.action as IntentAction,
    failures,
  };
}

export interface IntentSummary {
  cases: number;
  /** Tum alt iddialari gecen vaka orani (action + soru + faset + butce). */
  exactPassRate: number;
  action: MulticlassReport<IntentAction>;
}

export function summarizeIntent(rows: readonly IntentRow[]): IntentSummary {
  return {
    cases: rows.length,
    exactPassRate: mean(rows.map((r) => (r.failures.length === 0 ? 1 : 0))),
    action: multiclassReport(
      rows.map((r) => ({ expected: r.expectedAction, predicted: r.predictedAction })),
      ["clarify", "search"],
    ),
  };
}

export function runIntentEval(cases: readonly IntentCase[] = INTENT_CASES) {
  const rows = cases.map(evaluateIntentCase);
  return { rows, summary: summarizeIntent(rows) };
}
