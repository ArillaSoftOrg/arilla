import type { SearchIntent } from "@arilla/core";
import { describe, expect, it } from "vitest";
import { parseSortKey, sortModeFor } from "./chat-sort.ts";

const INTENT: SearchIntent = {
  query: "masa lambası",
  category: null,
  brand: null,
  excludeBrands: [],
  colors: [],
  size: null,
  priceMin: null,
  priceMax: null,
  attributes: {},
  sort: null,
};

describe("chat sort mapping (decision 0202)", () => {
  it("flag off: today's mapping is untouched", () => {
    expect(sortModeFor("secilen")).toBe("balanced");
    expect(sortModeFor("firsat")).toBe("best_deal");
    expect(sortModeFor("eslesme")).toBe("closest_match");
    expect(parseSortKey("eslesme", INTENT)).toBe("secilen"); // pasif sekme
  });

  it("flag on: three genuinely different text sorts", () => {
    expect(sortModeFor("secilen", true)).toBe("balanced");
    expect(sortModeFor("firsat", true)).toBe("lowest_price");
    expect(sortModeFor("eslesme", true)).toBe("best_match");
    const modes = new Set(
      ["secilen", "firsat", "eslesme"].map((k) => sortModeFor(k as never, true)),
    );
    expect(modes.size).toBe(3);
  });

  it("flag on: the match tab is selectable and a 'cheapest' intent opens the price tab", () => {
    expect(parseSortKey("eslesme", INTENT, true)).toBe("eslesme");
    expect(parseSortKey("firsat", INTENT, true)).toBe("firsat");
    expect(parseSortKey("bogus", INTENT, true)).toBe("secilen");
    expect(parseSortKey(undefined, { ...INTENT, sort: "cheapest" }, true)).toBe("firsat");
  });
});
