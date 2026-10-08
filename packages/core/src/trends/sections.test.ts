import { describe, expect, it } from "vitest";
import { resolveTrendHero } from "./hero.ts";
import { buildTrendSections, isTrendActiveNow } from "./sections.ts";
import { MIN_PUBLIC_TREND_PRODUCTS, type TrendSummary } from "./types.ts";

const NOW = new Date("2026-10-08T12:00:00Z");

describe("isTrendActiveNow", () => {
  const window = {
    activeFrom: new Date("2026-09-01T00:00:00Z"),
    activeUntil: new Date("2026-11-30T00:00:00Z"),
  };

  it("mevsimlik/kampanya trend pencere icindeyse aktif", () => {
    expect(isTrendActiveNow({ trendType: "seasonal", ...window }, NOW)).toBe(true);
    expect(isTrendActiveNow({ trendType: "campaign", ...window }, NOW)).toBe(true);
  });

  it("pencere disinda aktif degil; bitis ucu dahil degil", () => {
    expect(
      isTrendActiveNow({ trendType: "seasonal", ...window }, new Date("2026-08-31T23:59:59Z")),
    ).toBe(false);
    expect(isTrendActiveNow({ trendType: "seasonal", ...window }, window.activeUntil)).toBe(false);
    expect(isTrendActiveNow({ trendType: "seasonal", ...window }, window.activeFrom)).toBe(true);
  });

  it("evergreen asla 'su an' sayilmaz", () => {
    expect(isTrendActiveNow({ trendType: "evergreen", ...window }, NOW)).toBe(false);
  });

  it("penceresiz mevsimlik trend 'su an' degil; tek uclu pencere sinirsiz uc sayar", () => {
    expect(
      isTrendActiveNow({ trendType: "seasonal", activeFrom: null, activeUntil: null }, NOW),
    ).toBe(false);
    expect(
      isTrendActiveNow(
        { trendType: "seasonal", activeFrom: window.activeFrom, activeUntil: null },
        NOW,
      ),
    ).toBe(true);
    expect(
      isTrendActiveNow(
        { trendType: "seasonal", activeFrom: null, activeUntil: window.activeUntil },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("resolveTrendHero", () => {
  it("trend gorseli > temsilci urun gorseli > yer tutucu", () => {
    expect(resolveTrendHero("https://a.test/h.jpg", "https://a.test/p.jpg")).toEqual({
      url: "https://a.test/h.jpg",
      source: "trend",
    });
    expect(resolveTrendHero(null, "https://a.test/p.jpg")).toEqual({
      url: "https://a.test/p.jpg",
      source: "product",
    });
    expect(resolveTrendHero(null, null)).toEqual({ url: null, source: "placeholder" });
  });

  it("bos ve bosluk dizgisi 'yok' sayilir", () => {
    expect(resolveTrendHero("  ", "https://a.test/p.jpg").source).toBe("product");
    expect(resolveTrendHero("", "  ").source).toBe("placeholder");
    expect(resolveTrendHero(undefined, undefined).source).toBe("placeholder");
  });
});

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
    productCount: MIN_PUBLIC_TREND_PRODUCTS,
    startingPrice: null,
    thumbnails: [],
    ...overrides,
  };
}

describe("buildTrendSections", () => {
  it("kesitleri doldurur ve girdi sirasini korur", () => {
    const sections = buildTrendSections([
      trend(1, { featured: true }),
      trend(2, { category: "guzellik", activeNow: true, trendType: "seasonal" }),
      trend(3, { category: "ev-yasam" }),
      trend(4, { category: "ogrenci", trendType: "campaign" }),
      trend(5, { category: "genel" }),
      trend(6),
    ]);
    expect(sections.featured.map((t) => t.id)).toEqual([1]);
    expect(sections.now.map((t) => t.id)).toEqual([2]);
    expect(sections.byCategory.moda.map((t) => t.id)).toEqual([1, 6]);
    expect(sections.byCategory.guzellik.map((t) => t.id)).toEqual([2]);
    expect(sections.byCategory["ev-yasam"].map((t) => t.id)).toEqual([3]);
    expect(sections.byCategory.ogrenci.map((t) => t.id)).toEqual([4]);
    expect(sections.seasonal.map((t) => t.id)).toEqual([2, 4]);
    expect(sections.all.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("'genel' kategori konu sekmelerine girmez ama Tum Trendler'de yer alir", () => {
    const sections = buildTrendSections([trend(5, { category: "genel" })]);
    expect(Object.values(sections.byCategory).flat()).toHaveLength(0);
    expect(sections.all).toHaveLength(1);
  });

  it("bos girdi bos kesit verir", () => {
    const sections = buildTrendSections([]);
    expect(sections.all).toEqual([]);
    expect(sections.featured).toEqual([]);
  });
});
