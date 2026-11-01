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
  it("ornek aramalar gecmisten once gelir; eksik fiyat ve sifir magaza acik gosterilir", () => {
    const html = render(toRecentProducts([{ ...nike, minPrice: null, offerCount: 0 }]));
    expect(html.indexOf('aria-label="Örnek aramalar"')).toBeLessThan(html.indexOf(TITLE));
    expect(html).toContain("Fiyatı incele");
    expect(html).not.toContain("0 mağaza");
  });
  it("yardim CTA'si arama formunun disinda ve son bakilanlardan once kalir", () => {
    const html = renderToStaticMarkup(
      createElement(HomeSearchComposer, {
        recentProducts: toRecentProducts([nike]),
        afterSearch: createElement("a", { href: "/nasil-calisir" }, "Nasıl çalıştığını gör"),
      }),
    );
    const cta = html.indexOf('href="/nasil-calisir"');
    expect(cta).toBeGreaterThan(html.indexOf("</form>"));
    expect(cta).toBeLessThan(html.indexOf(TITLE));
    expect(html).toContain("Nike Air Force 1");
  });

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

describe("ana sayfa fotograf aksiyonu", () => {
  it("misafire gorunur etiket sunar, dosya secimi yerine mevcut giris kapisini korur", () => {
    const html = renderToStaticMarkup(
      createElement(HomeSearchComposer, { imageEntryAvailable: true }),
    );
    expect(html).toContain("Fotoğraf yükle</button>");
    expect(html).not.toContain('type="file"');
    expect(html).toContain('aria-label="Fotoğraf eklemek için ana arama kutusuna git"');
  });

  it("fotograf acikken gorunur etiket ve mevcut dosya secimi birlikte kalir", () => {
    const html = renderToStaticMarkup(
      createElement(HomeSearchComposer, { imageEntryAvailable: true, imageChat: true }),
    );
    expect(html).toContain("Fotoğraf yükle</button>");
    expect(html).toContain('type="file"');
  });

  it("ozellik kapaliyken fotograf akisini kendiliginden acmaz", () => {
    const html = render();
    expect(html).not.toContain("Fotoğraf yükle</button>");
    expect(html).not.toContain('type="file"');
  });
});
