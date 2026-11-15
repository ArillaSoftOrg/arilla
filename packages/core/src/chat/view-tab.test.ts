import { describe, expect, it } from "vitest";
import {
  CHAT_VIEW_TABS,
  factSortFor,
  parseViewTab,
  resolveViewTab,
  sortModeForTab,
} from "./view-tab.ts";

describe("parseViewTab", () => {
  it("accepts the three tab keys and drops anything else", () => {
    for (const tab of CHAT_VIEW_TABS) expect(parseViewTab(tab)).toBe(tab);
    for (const bad of [null, undefined, "", "SECILEN", "balanced", 3, {}, ["firsat"]]) {
      expect(parseViewTab(bad)).toBeNull();
    }
  });
});

describe("resolveViewTab", () => {
  const plain = { sort: null } as const;
  const cheapest = { sort: "cheapest" } as const;

  it("honours an explicit tab", () => {
    expect(resolveViewTab("firsat", plain, { uxV2: false })).toBe("firsat");
    expect(resolveViewTab("secilen", cheapest, { uxV2: true })).toBe("secilen");
  });

  it("opens the price tab when the intent asked for cheaper and no tab was chosen", () => {
    expect(resolveViewTab(null, cheapest, { uxV2: false })).toBe("firsat");
    expect(resolveViewTab(undefined, plain, { uxV2: true })).toBe("secilen");
  });

  it("eslesme exists only in v2 (or when closest match is supported)", () => {
    expect(resolveViewTab("eslesme", plain, { uxV2: true })).toBe("eslesme");
    expect(resolveViewTab("eslesme", plain, { uxV2: false })).toBe("secilen");
    expect(resolveViewTab("eslesme", plain, { uxV2: false, closestMatchSupported: true })).toBe(
      "eslesme",
    );
  });
});

describe("sort mapping", () => {
  it("v2: price tab is lowest_price, match tab is best_match", () => {
    expect(sortModeForTab("secilen", true)).toBe("balanced");
    expect(sortModeForTab("firsat", true)).toBe("lowest_price");
    expect(sortModeForTab("eslesme", true)).toBe("best_match");
  });

  it("v1: unchanged mapping (deals = best_deal, matches = closest_match)", () => {
    expect(sortModeForTab("firsat", false)).toBe("best_deal");
    expect(sortModeForTab("eslesme", false)).toBe("closest_match");
  });

  it("answer facts never use closest_match (text search has no anchor)", () => {
    expect(factSortFor("eslesme", false)).toBe("balanced");
    expect(factSortFor("firsat", false)).toBe("best_deal");
    expect(factSortFor("firsat", true)).toBe("lowest_price");
    expect(factSortFor("eslesme", true)).toBe("best_match");
  });
});
