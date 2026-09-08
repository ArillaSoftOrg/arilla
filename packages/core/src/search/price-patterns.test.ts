import { describe, expect, it } from "vitest";
import { extractPricePatterns } from "./price-patterns.ts";

describe("extractPricePatterns", () => {
  it("parses 'X tl altı' as an upper bound in kurus", () => {
    const [match] = extractPricePatterns("3000 tl altı siyah ayakkabı");
    expect(match).toMatchObject({ priceMax: 300000 });
    expect(match?.priceMin).toBeUndefined();
  });

  it("parses 'X altında' without the tl unit", () => {
    const [match] = extractPricePatterns("3000 altında bir şey");
    expect(match).toMatchObject({ priceMax: 300000 });
  });

  it("parses the '-X₺' shorthand", () => {
    const [match] = extractPricePatterns("-3000₺ ayakkabı");
    expect(match).toMatchObject({ priceMax: 300000 });
  });

  it("parses 'X-Y arası' as a range", () => {
    const [match] = extractPricePatterns("2000-3000 arası ayakkabı");
    expect(match).toMatchObject({ priceMin: 200000, priceMax: 300000 });
  });

  it("returns nothing when there is no price pattern", () => {
    expect(extractPricePatterns("siyah spor ayakkabı")).toHaveLength(0);
  });
});
