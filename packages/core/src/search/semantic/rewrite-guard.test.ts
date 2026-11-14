import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../lexicon.ts";
import { verifyRewrite } from "./rewrite-guard.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "synonym", surface: "kablosuz", normalized: "kablosuz", weight: 1 },
  { kind: "synonym", surface: "wireless", normalized: "kablosuz", weight: 1 },
  { kind: "synonym", surface: "deri", normalized: "deri", weight: 1 },
  { kind: "synonym", surface: "leather", normalized: "deri", weight: 1 },
];
const BRANDS = ["DeWalt", "Makita", "Samsung"];

describe("yeniden yazim dogrulayicisi (E4-b)", () => {
  it.each([
    ["kabin boy valiz", "cabin size carry-on suitcase"],
    ["puset minderi", "stroller seat cushion"],
    ["DDR5 32GB bellek", "DDR5 32GB RAM memory"],
    ["DeWalt 20V batarya tutucu", "DeWalt 20V battery holder"],
    ["kablosuz olmayan oyun klavyesi", "wired gaming keyboard"],
    ["kablosuz olmayan oyun klavyesi", "non-wireless gaming keyboard"],
    ["deri olmayan çocuk botu", "leather-free kids boots"],
  ])("%s -> %s kabul edilir", (raw, rewrite) => {
    expect(verifyRewrite(raw, rewrite, LEXICON, BRANDS)).toEqual({ accepted: true, reason: null });
  });

  it.each([
    ["DDR5 32GB bellek", "DDR4 32GB RAM", "spec_lost"],
    ["Makita BL1830 batarya adaptörü", "Makita BL1850 battery adapter", "spec_lost"],
    ["kablosuz olmayan oyun klavyesi", "wireless gaming keyboard", "negation_flipped"],
    ["deri olmayan çocuk botu", "kids leather boots", "negation_flipped"],
    ["DeWalt 20V batarya tutucu", "20V battery holder", "brand_lost"],
    ["çocuk ayakkabısı", "kids shoes under 500", "number_invented"],
    ["laptop", "", "empty"],
    ["laptop", "laptop https://example.com", "unsafe_content"],
  ])("%s -> %s reddedilir (%s)", (raw, rewrite, reason) => {
    expect(verifyRewrite(raw, rewrite, LEXICON, BRANDS)).toEqual({ accepted: false, reason });
  });
});
