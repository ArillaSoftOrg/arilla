import { describe, expect, it } from "vitest";
import { decideClarification } from "./clarification.ts";

describe("decideClarification", () => {
  it("does not clarify when there are no candidates", () => {
    expect(decideClarification([])).toEqual({
      needsClarification: false,
      candidateCategoryIds: [],
    });
  });

  it("does not clarify when one candidate dominates the volume", () => {
    const result = decideClarification([
      { categoryId: 1, categoryPath: "spor/bisiklet-kaski", matchCount: 95 },
      { categoryId: 2, categoryPath: "spor/motosiklet-kaski", matchCount: 5 },
    ]);
    expect(result).toEqual({ needsClarification: false, candidateCategoryIds: [1] });
  });

  it("clarifies when volume is balanced across candidates", () => {
    const result = decideClarification([
      { categoryId: 1, categoryPath: "spor/bisiklet-kaski", matchCount: 48 },
      { categoryId: 2, categoryPath: "spor/motosiklet-kaski", matchCount: 52 },
    ]);
    expect(result.needsClarification).toBe(true);
    expect(result.candidateCategoryIds.sort()).toEqual([1, 2]);
  });

  it("drops candidates below the minimum share as noise", () => {
    const result = decideClarification([
      { categoryId: 1, categoryPath: "spor/bisiklet-kaski", matchCount: 90 },
      { categoryId: 2, categoryPath: "spor/is-guvenligi", matchCount: 2 },
    ]);
    expect(result).toEqual({ needsClarification: false, candidateCategoryIds: [1] });
  });
});
