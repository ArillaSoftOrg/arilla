import type { TrendSummary } from "@arilla/core";
import { describe, expect, it } from "vitest";
import { buildTrendsPageModel, SECTION_CARD_LIMIT } from "./trend-page-model.ts";
import { isTrendSlug } from "./trend-slug.ts";

function trend(id: number, overrides: Partial<TrendSummary> = {}): TrendSummary {
  return {
    id,
    slug: `t-${id}`,
    title: `Trend ${id}`,
    description: "Açıklama.",
    category: "moda",
    trendType: "evergreen",
    featured: false,
    activeNow: false,
    heroImageUrl: null,
    heroSource: "placeholder",
    productCount: 12,
    startingPrice: null,
    thumbnails: [],
    ...overrides,
  };
}

describe("buildTrendsPageModel", () => {
  it("ilk gorunum tum trendleri yigmaz: kesit basina sinirli kart", () => {
    const many = Array.from({ length: 50 }, (_, i) => trend(i + 1));
    const model = buildTrendsPageModel(many);
    const shown = model.sections.flatMap((section) => section.trends);
    expect(shown.length).toBeLessThan(many.length);
    for (const section of model.sections) {
      expect(section.trends.length).toBeLessThanOrEqual(SECTION_CARD_LIMIT[section.key]);
    }
    expect(model.all).toHaveLength(50);
  });

  it("ayni trend iki kesitte tekrarlanmaz (ustteki kesit kazanir)", () => {
    const model = buildTrendsPageModel([
      trend(1, { featured: true, trendType: "seasonal", activeNow: true }),
      trend(2, { trendType: "seasonal", activeNow: true }),
    ]);
    const ids = model.sections.flatMap((section) => section.trends.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(model.sections[0]?.key).toBe("featured");
    expect(model.sections[0]?.trends.map((t) => t.id)).toEqual([1]);
  });

  it("bos kesit hic uretilmez; sira: one cikanlar, su an, konular, sezonluk", () => {
    const model = buildTrendsPageModel([
      trend(1, { category: "guzellik" }),
      trend(2, { featured: true, category: "ogrenci" }),
      trend(3, { category: "moda", trendType: "seasonal" }),
    ]);
    expect(model.sections.map((s) => s.key)).toEqual(["featured", "moda", "guzellik"]);
  });

  it("hic trend yoksa kesit yok", () => {
    expect(buildTrendsPageModel([]).sections).toEqual([]);
  });
});

describe("isTrendSlug", () => {
  it.each(["kuru-ciltlere-son", "5-dakikada-hazir", "11-11de-alinacaklar"])(
    "%s gecerli",
    (slug) => {
      expect(isTrendSlug(slug)).toBe(true);
    },
  );

  it.each(["", "Kuru-Ciltlere", "a b", "a--b", "-a", "a-", "../etc", "a/b", `${"a".repeat(81)}`])(
    "%j gecersiz",
    (slug) => {
      expect(isTrendSlug(slug)).toBe(false);
    },
  );
});
