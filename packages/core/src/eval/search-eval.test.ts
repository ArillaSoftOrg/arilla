import { describe, expect, it } from "vitest";
import { compareSearch, type SearchEvalRow, summarizeSearch } from "./search-eval.ts";

const row = (over: Partial<SearchEvalRow>): SearchEvalRow => ({
  q: "x",
  absent: false,
  returned: 10,
  relevance: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  relevantInCatalog: 5,
  zeroResultCorrect: null,
  usedFallback: false,
  ...over,
});

describe("summarizeSearch", () => {
  it("tam isabette P@5 ve NDCG@10 = 1", () => {
    const s = summarizeSearch([row({})]);
    expect(s.precisionAt5).toBe(1);
    expect(s.ndcgAt10).toBeCloseTo(1);
    expect(s.zeroResultRate).toBe(0);
  });

  it("karsiligi olmayan sorguda bos donmek dogrudur, P@5'i etkilemez", () => {
    const s = summarizeSearch([
      row({}),
      row({
        absent: true,
        returned: 0,
        relevance: [],
        relevantInCatalog: 0,
        zeroResultCorrect: true,
      }),
    ]);
    expect(s.precisionAt5).toBe(1);
    expect(s.absentCorrectRate).toBe(1);
    expect(s.zeroResultRate).toBe(0.5);
  });

  it("hic ilgili donmeyen sorgu missRate'e girer", () => {
    const s = summarizeSearch([row({ relevance: [0, 0, 0, 0, 0] }), row({})]);
    expect(s.missRate).toBe(0.5);
  });
});

describe("compareSearch", () => {
  it("P@5 dususte regresyon bildirir", () => {
    const good = summarizeSearch([row({})]);
    const bad = summarizeSearch([row({ relevance: [0, 0, 1, 0, 0] })]);
    const changes = compareSearch(good, bad);
    expect(changes.find((c) => c.metric === "precisionAt5")?.regressed).toBe(true);
  });
});
