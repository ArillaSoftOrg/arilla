import { describe, expect, it } from "vitest";
import { runIntentEval } from "./intent-eval.ts";
import { searchStoredMetrics } from "./metric-keys.ts";
import { intentCases, searchCases } from "./record-cases.ts";
import type { SearchEvalRow } from "./search-eval.ts";

const row = (over: Partial<SearchEvalRow>): SearchEvalRow => ({
  q: "ornek sorgu",
  absent: false,
  returned: 5,
  relevance: [1, 0, 0, 0, 0],
  relevantInCatalog: 3,
  zeroResultCorrect: null,
  usedFallback: false,
  ...over,
});

describe("intentCases", () => {
  it("is deterministic and never stores the raw query", () => {
    const first = intentCases(runIntentEval().rows);
    const second = intentCases(runIntentEval().rows);
    expect(first).toEqual(second);
    const json = JSON.stringify(first);
    for (const r of runIntentEval().rows) expect(json).not.toContain(r.query);
    expect(first.every((c) => /^[0-9a-f]{24}$/.test(c.caseKey))).toBe(true);
    expect(new Set(first.map((c) => c.caseKey)).size).toBe(first.length);
  });
});

describe("searchCases", () => {
  it("classifies hit, miss, zero result and absent queries", () => {
    const cases = searchCases([
      row({ q: "a" }),
      row({ q: "b", relevance: [0, 0] }),
      row({ q: "c", returned: 0, relevance: [] }),
      row({ q: "d", zeroResultCorrect: true, returned: 0, relevance: [] }),
      row({ q: "e", zeroResultCorrect: false }),
    ]);
    expect(cases.map((c) => [c.outcome, c.failureClass ?? null])).toEqual([
      ["pass", null],
      ["fail", "low_rank"],
      ["fail", "zero_result"],
      ["pass", null],
      ["fail", "false_match"],
    ]);
    expect(JSON.stringify(cases)).not.toContain('"q"');
  });
});

describe("searchStoredMetrics", () => {
  const base = {
    precisionAt5: 0.4,
    ndcgAt10: 0.5,
    zeroResultRate: 0.1,
    missRate: 0.2,
    absentCorrectRate: 1,
  };
  it("omits metrics whose denominator is empty instead of inventing 0", () => {
    expect(searchStoredMetrics({ ...base, queries: 3, scoredQueries: 3 })).not.toHaveProperty(
      "absent_correct_rate",
    );
    expect(searchStoredMetrics({ ...base, queries: 0, scoredQueries: 0 })).toEqual({});
    expect(searchStoredMetrics({ ...base, queries: 2, scoredQueries: 0 })).toEqual({
      zero_result_rate: 0.1,
      absent_correct_rate: 1,
    });
  });
});
