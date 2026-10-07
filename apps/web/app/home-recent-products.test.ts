import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import { loadRecentProducts, toRecentProducts } from "./home-recent-products.ts";
import { HomeSearchComposer } from "./home-search-composer-client.tsx";

const TITLE = "Alışverişe devam et";
const at = new Date("2026-03-01T10:00:00.000Z");

const deck = {
  productId: 11,
  slug: "deck-erkek-antasit-sneaker",
  title: "Deck Erkek Antasit Sneaker",
  primaryImageUrl: "https://img.example/deck.jpg",
  minPrice: 299800,
  offerCount: 1,
  viewedAt: at,
};
const nike = {
  ...deck,
  productId: 12,
  slug: "nike-air-force",
  title: "Nike Air Force 1",
  viewedAt: at,
};

function render(recentProducts?: ReturnType<typeof toRecentProducts>) {
  return renderToStaticMarkup(createElement(HomeSearchComposer, { recentProducts }));
}

describe("toRecentProducts", () => {
  it("sırayı korur; /urun/{slug} ve ürün kimliği hesaptaki geçmişle aynı", () => {
    const out = toRecentProducts([nike, deck]);
    expect(out.map((p) => p.productId)).toEqual([12, 11]);
    expect(out[1]).toMatchObject({ href: "/urun/deck-erkek-antasit-sneaker", minPrice: 299800 });
  });
});

describe("loadRecentProducts", () => {
  it("misafir için veritabanına gitmeden boş döner", async () => {
    expect(await loadRecentProducts(null)).toEqual([]);
  });
});

describe("ana sayfa 'Alışverişe devam et' bölümü", () => {
  it("ürün geçmişi yok -> bölüm, başlık ve liste çizilmez; arama chip'i yok", () => {
    for (const html of [render(undefined), render([])]) {
      expect(html).not.toContain(TITLE);
      expect(html).not.toContain("<ul");
      expect(html).not.toContain("/ara?q=");
    }
  });

  it("görüntülenen ürün -> görsel, başlık, fiyat, mağaza sayısı; en yeni önce", () => {
    const html = render(toRecentProducts([nike, deck]));
    expect(html).toContain(TITLE);
    expect(html).toContain('href="/urun/deck-erkek-antasit-sneaker"');
    expect(html).toContain("Deck Erkek Antasit Sneaker");
    expect(html).toContain("2.998");
    expect(html).toContain("1 mağaza");
    expect(html).toContain("deck.jpg");
    expect(html.indexOf("Nike Air Force 1")).toBeLessThan(html.indexOf("Deck Erkek"));
  });

  it("eski sabit örnek kartlar yok", () => {
    const html = render([]);
    for (const demo of ["Beyaz sneaker", "Çalışma koltuğu", "Popüler arama", "Trend fikir"]) {
      expect(html).not.toContain(demo);
    }
  });
});
