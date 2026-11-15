import { describe, expect, it } from "vitest";
import {
  CHAT_TAB_ITEM_CAP,
  MAX_OPEN_OLDER_BLOCKS,
  openBlocksHref,
  parseOpenSeqs,
  revealPlan,
  toggleOpenSeqs,
  webCardLimit,
} from "./chat-open.ts";

const VALID = new Set([2, 4, 6, 8]);

describe("parseOpenSeqs", () => {
  it("keeps only known older block seqs, in order, without duplicates", () => {
    expect(parseOpenSeqs("2,4", VALID)).toEqual([2, 4]);
    expect(parseOpenSeqs("4,4,2", VALID)).toEqual([4, 2]);
  });
  it("drops unknown, malformed and huge values", () => {
    expect(parseOpenSeqs("2,abc,-1,99,1e3,0x4, 4,4.5,12345678901", VALID)).toEqual([2]);
    expect(parseOpenSeqs("", VALID)).toEqual([]);
    expect(parseOpenSeqs(undefined, VALID)).toEqual([]);
  });
  it("never opens more than the cap: the newest requests win", () => {
    expect(parseOpenSeqs("2,4,6,8", VALID)).toEqual([6, 8]);
    expect(MAX_OPEN_OLDER_BLOCKS).toBe(2);
  });
  it("bounds the work for absurdly long parameters", () => {
    const long = Array.from({ length: 5000 }, () => "2").join(",");
    expect(parseOpenSeqs(long, VALID)).toEqual([2]);
  });
});

describe("toggleOpenSeqs", () => {
  it("opens, closes and evicts the oldest open block", () => {
    expect(toggleOpenSeqs([], 2)).toEqual([2]);
    expect(toggleOpenSeqs([2], 2)).toEqual([]);
    expect(toggleOpenSeqs([2, 4], 6)).toEqual([4, 6]);
  });
});

describe("openBlocksHref", () => {
  it("writes only meaningful params", () => {
    expect(openBlocksHref("abc", [])).toBe("/sohbet/abc");
    expect(openBlocksHref("abc", [2, 4])).toBe("/sohbet/abc?ac=2%2C4");
    expect(openBlocksHref("abc", [4], "firsat")).toBe("/sohbet/abc?sirala=firsat&ac=4");
  });
});

describe("webCardLimit: catalog + web never exceed the tab cap", () => {
  it("leaves the remaining room", () => {
    expect(webCardLimit(0)).toBe(CHAT_TAB_ITEM_CAP);
    expect(webCardLimit(20)).toBe(10);
    expect(webCardLimit(30)).toBe(0);
    expect(webCardLimit(45)).toBe(0);
  });
});

describe("revealPlan", () => {
  it("shows everything when it fits, otherwise the first cards and a button", () => {
    expect(revealPlan(4, false)).toEqual({ visible: 4, needsButton: false });
    expect(revealPlan(6, false)).toEqual({ visible: 6, needsButton: false });
    expect(revealPlan(30, false)).toEqual({ visible: 6, needsButton: true });
    expect(revealPlan(30, true)).toEqual({ visible: 30, needsButton: true });
    expect(revealPlan(0, false)).toEqual({ visible: 0, needsButton: false });
  });
});
