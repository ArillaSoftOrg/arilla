import { describe, expect, it } from "vitest";
import { isChatUxV2Enabled } from "./config.ts";
import { summarizeResults } from "./result-summary.ts";

describe("summarizeResults", () => {
  it("counts displayed products and distinct best-offer stores (case-insensitive)", () => {
    expect(
      summarizeResults([
        { merchantName: "Hepsiburada" },
        { merchantName: "hepsiburada " },
        { merchantName: "AliExpress" },
        { merchantName: null },
        {},
      ]),
    ).toEqual({ productCount: 5, storeCount: 2 });
  });

  it("store count is null when no card names its store", () => {
    expect(summarizeResults([{ merchantName: null }, {}])).toEqual({
      productCount: 2,
      storeCount: null,
    });
  });

  it("empty list", () => {
    expect(summarizeResults([])).toEqual({ productCount: 0, storeCount: null });
  });
});

describe("isChatUxV2Enabled", () => {
  it("is off by default and needs the chat itself to be on", () => {
    expect(isChatUxV2Enabled({})).toBe(false);
    expect(isChatUxV2Enabled({ CHAT_UX_V2: "true" })).toBe(false);
    expect(isChatUxV2Enabled({ CHAT_DISCOVERY_ENABLED: "true" })).toBe(false);
    expect(isChatUxV2Enabled({ CHAT_DISCOVERY_ENABLED: "true", CHAT_UX_V2: "true" })).toBe(true);
    expect(isChatUxV2Enabled({ CHAT_DISCOVERY_ENABLED: "true", CHAT_UX_V2: "1" })).toBe(false);
  });
});
