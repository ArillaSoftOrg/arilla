import type { TrendSummary } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrendCardGrid, trendHref } from "./trend-cards.tsx";
import { moreProductsLabel, TREND_COPY } from "./trend-copy.ts";

function trend(overrides: Partial<TrendSummary> = {}): TrendSummary {
  return {
    id: 1,
    slug: "kuru-ciltlere-son",
    title: "Kuru Ciltlere Son",
    description: "Nemi içeride tutan bakımlar.",
    category: "guzellik",
    trendType: "evergreen",
    featured: false,
    activeNow: false,
    heroImageUrl: "https://img.test.example/h.jpg",
    heroSource: "product",
    productCount: 24,
    startingPrice: 123_450,
    thumbnails: [1, 2, 3, 4].map((n) => ({
      productId: n,
      title: `Ürün ${n}`,
      brandName: "Marka",
      imageUrl: `https://img.test.example/${n}.jpg`,
    })),
    ...overrides,
  };
}

function render(trends: TrendSummary[], eagerFirst = false): string {
  return renderToStaticMarkup(createElement(TrendCardGrid, { trends, eagerFirst }));
}

describe("TrendCardGrid", () => {
  it("her kart tek baglanti: /trendler/<slug>, baslik baglanti metni", () => {
    const html = render([trend()]);
    expect(trendHref("kuru-ciltlere-son")).toBe("/trendler/kuru-ciltlere-son");
    expect(html).toContain('href="/trendler/kuru-ciltlere-son"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a [^>]*>Kuru Ciltlere Son<\/a>/);
  });

  it("liste semantigi, aciklama, +N urun ve 'X TL'den baslayan'", () => {
    const html = render([trend()]);
    expect(html).toContain('role="list"');
    expect(html).toContain("Nemi içeride tutan bakımlar.");
    expect(html).toContain(moreProductsLabel(20)); // 24 - 4 onizleme
    expect(html).toContain("1.234,50 TL&#x27;den başlayan");
  });

  it("veri yoksa fiyat ve '+N urun' uydurulmaz", () => {
    const html = render([trend({ startingPrice: null, productCount: 4 })]);
    expect(html).not.toContain("başlayan");
    expect(html).not.toContain("+0");
    expect(html).not.toMatch(/\+\d+ ürün/);
  });

  it("kapak yoksa bozuk <img> yerine yer tutucu kutusu", () => {
    const html = render([trend({ heroImageUrl: null, heroSource: "placeholder" })]);
    expect(html).not.toContain("h.jpg");
    expect(html).toMatch(/aria-hidden="true"/);
  });

  it("yalnizca ilk satirin kapaklari eager, ilki yuksek oncelikli", () => {
    const html = render(
      [1, 2, 3, 4].map((id) => trend({ id, slug: `t-${id}` })),
      true,
    );
    expect(html.match(/loading="eager"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('fetchPriority="high"');
    const lazy = render([trend()], false);
    expect(lazy).not.toContain('loading="eager"');
  });

  it("onizleme gorselleri dekoratif; urun adi gorunmez metin olarak okunur", () => {
    const html = render([trend()]);
    expect(html).toContain('alt=""');
    expect(html).toContain("Marka Ürün 1");
  });

  it("arayuz metninde yasakli kelime ve ALL CAPS yok", () => {
    const html = render([trend()]);
    const copy = JSON.stringify(TREND_COPY) + html;
    expect(copy.toLocaleLowerCase("tr-TR")).not.toMatch(/satın al|dupe|ucuz/);
    expect(TREND_COPY.sections.featured).not.toBe(TREND_COPY.sections.featured.toUpperCase());
  });
});
