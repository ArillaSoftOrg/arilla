import type { TrendSummary } from "@arilla/core";
import { FallbackImage, TrendThumbnails } from "@arilla/ui";
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
    heroCandidates: ["https://img.test.example/h.jpg", "https://img.test.example/2.jpg"],
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

describe("FallbackImage (SSR)", () => {
  const render = (props: Parameters<typeof FallbackImage>[0]) =>
    renderToStaticMarkup(createElement(FallbackImage, props));

  it("ilk adayi cizer; sonrakiler kirik gorselde istemcide denenir", () => {
    const html = render({ srcs: ["https://a.test/1.jpg", "https://a.test/2.jpg"], alt: "" });
    expect(html).toContain("https://a.test/1.jpg");
    expect(html).not.toContain("https://a.test/2.jpg");
  });

  it("aday yoksa <img> yerine yer tutucu kutusu", () => {
    const html = render({ srcs: [], alt: "", placeholderClassName: "ph" });
    expect(html).not.toContain("<img");
    expect(html).toContain('class="ph"');
  });
});

describe("TrendThumbnails (SSR)", () => {
  const pool = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: String(n),
    title: `Ürün ${n}`,
    imageUrl: `https://img.test.example/${n}.jpg`,
  }));
  const render = (props: Parameters<typeof TrendThumbnails>[0]) =>
    renderToStaticMarkup(createElement(TrendThumbnails, props));

  it("havuz gorunenden buyukse yalniz ilk N gorunur; kalanlar kirik gorsele yedek bekler", () => {
    const html = render({ products: pool, visibleCount: 4, moreText: "+20 ürün" });
    expect(html.match(/<img /g)).toHaveLength(4);
    expect(html).toContain("1.jpg");
    expect(html).not.toContain("5.jpg");
    expect(html).toContain("+20 ürün");
  });

  it("onizleme de '+N' de yoksa hic bos kutu/liste cizilmez", () => {
    expect(render({ products: [], visibleCount: 4 })).toBe("");
  });

  it("kart '+N urun'u GORUNEN sayiya gore yazar (havuza gore degil)", () => {
    const html = renderToStaticMarkup(
      createElement(TrendCardGrid, {
        trends: [
          trend({
            productCount: 24,
            thumbnails: pool.map((p) => ({
              productId: Number(p.id),
              title: p.title,
              brandName: null,
              imageUrl: p.imageUrl,
            })),
          }),
        ],
      }),
    );
    expect(html).toContain("+20 ürün"); // 24 - 4 gorunen
    expect(html.match(/class="[^"]*productImage[^"]*"/g) ?? []).toHaveLength(4);
  });
});

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
    const html = render([
      trend({ heroImageUrl: null, heroSource: "placeholder", heroCandidates: [] }),
    ]);
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
