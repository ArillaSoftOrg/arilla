import { describe, expect, it } from "vitest";
import { searchStoredMetrics } from "./metric-keys.ts";

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
  it("keeps every metric for legacy callers that pass no denominators", () => {
    expect(Object.keys(searchStoredMetrics(base)).sort()).toEqual([
      "absent_correct_rate",
      "miss_rate",
      "ndcg_at_10",
      "precision_at_5",
      "zero_result_rate",
    ]);
  });
});
