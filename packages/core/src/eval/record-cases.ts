/**
 * Degerlendirme satirlarini saklanacak vakalara cevirir (Faz 1A-4). Saf.
 * Ham sorgu yazilmaz: yalnizca `caseKey` ve kisa, sabit sinif adlari.
 */
import type { IntentRow } from "./intent-eval.ts";
import { precisionAtK } from "./metrics.ts";
import type { SearchEvalRow } from "./search-eval.ts";
import { caseKey, type EvalCaseInput } from "./store.ts";

export function intentCases(rows: readonly IntentRow[]): EvalCaseInput[] {
  return rows.map((r) => {
    const failed = r.failures.length > 0;
    const wrongAction = r.expectedAction !== r.predictedAction;
    return {
      caseKey: caseKey("intent", r.query),
      outcome: failed ? "fail" : "pass",
      ...(failed ? { failureClass: wrongAction ? "wrong_action" : "assertion_mismatch" } : {}),
      score: failed ? 0 : 1,
      detail: { expected: r.expectedAction, predicted: r.predictedAction },
    };
  });
}

export function searchCases(rows: readonly SearchEvalRow[]): EvalCaseInput[] {
  return rows.map((r) => {
    const key = caseKey("search", r.q);
    if (r.zeroResultCorrect !== null) {
      return {
        caseKey: key,
        outcome: r.zeroResultCorrect ? "pass" : "fail",
        ...(r.zeroResultCorrect ? {} : { failureClass: "false_match" }),
        detail: { absent: true, returned: r.returned },
      } as EvalCaseInput;
    }
    const hit = r.relevance.some((x) => x > 0);
    return {
      caseKey: key,
      outcome: hit ? "pass" : "fail",
      ...(hit ? {} : { failureClass: r.returned === 0 ? "zero_result" : "low_rank" }),
      score: precisionAtK(r.relevance, 5),
      detail: { returned: r.returned, fallback: r.usedFallback },
    } as EvalCaseInput;
  });
}
