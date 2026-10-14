import { describe, expect, it } from "vitest";

import { extractFromPage, matchTitle, priceTextToKurus } from "./extract.js";

// Sentetik veri: canli sonuc DEGILDIR.
const TY = "https://www.trendyol.com";
const now = "2026-01-01T00:00:00.000Z";

function tyScript(products) {
  return `window["__single-search-result__PROPS"]=${JSON.stringify({ data: { query: "q", products } })};`;
}

const ty = (name, priceText, url) => ({
  name,
  brand: "Apple",
  price: { currency: "TL", currentText: priceText, discountedPriceText: priceText },
  image: "https://cdn.test/a.jpg",
  url,
});

describe("priceTextToKurus", () => {
  it("Turkce bicimleri kurusa cevirir", () => {
    expect(priceTextToKurus("72.989")).toBe(7_298_900);
    expect(priceTextToKurus("1.499,90")).toBe(149_990);
    expect(priceTextToKurus("1499.90")).toBe(149_990);
    expect(priceTextToKurus("abc")).toBeNull();
    expect(priceTextToKurus("0")).toBeNull();
  });
});

describe("matchTitle", () => {
  it("varyant ve yenilenmis urunu eler", () => {
    expect(matchTitle("Apple iPhone 16 Pro 128GB Siyah", "iPhone 16 Pro 128 GB")).toBe(true);
    expect(matchTitle("Apple iPhone 16 Pro Max 128GB", "iPhone 16 Pro 128 GB")).toBe(false);
    expect(matchTitle("Apple iPhone 16 Pro 128GB Yenilio A Kalite", "iPhone 16 Pro")).toBe(false);
    expect(matchTitle("Apple iPhone 16 128GB", "iPhone 16 Pro")).toBe(false);
  });
});

describe("extractFromPage", () => {
  it("Trendyol gomulu arama nesnesinden en fazla 3 eslesme dondurur", () => {
    const products = [
      ty(
        "iPhone 16 Pro 128GB Siyah",
        "64.999",
        "/apple/iphone-16-pro-128gb-siyah-p-1?merchantId=1",
      ),
      ty("iPhone 16 Pro Max 256GB", "80.000", "/apple/iphone-16-pro-max-p-2"),
      ty("iPhone 16 Pro 256GB Beyaz", "70.000", "/apple/iphone-16-pro-256gb-p-3"),
    ];
    const r = extractFromPage({
      scriptTexts: [tyScript(products)],
      jsonLdTexts: [],
      origin: TY,
      query: "iPhone 16 Pro",
      checkedAt: now,
    });
    expect(r.source).toBe("trendyol-embedded-search-props");
    expect(r.totalOnPage).toBe(3);
    expect(r.products.map((p) => p.productUrl)).toEqual([
      `${TY}/apple/iphone-16-pro-128gb-siyah-p-1`,
      `${TY}/apple/iphone-16-pro-256gb-p-3`,
    ]);
    expect(r.products[0]).toMatchObject({
      priceKurus: 6_499_900,
      currency: "TRY",
      price: "64.999,00",
    });
  });

  it("fiyat metni bozuksa fiyat uretmez", () => {
    const r = extractFromPage({
      scriptTexts: [tyScript([ty("iPhone 16 Pro", "fiyat yok", "/apple/x-p-1")])],
      jsonLdTexts: [],
      origin: TY,
      query: "iPhone 16 Pro",
      checkedAt: now,
    });
    expect(r.products[0]).toMatchObject({ priceKurus: null, price: null, currency: null });
    expect(r.products[0].missing).toContain("priceKurus");
  });

  it("baska alan adinin urun adresini kabul etmez", () => {
    const r = extractFromPage({
      scriptTexts: [tyScript([ty("iPhone 16 Pro", "1", "https://evil.test/x-p-1")])],
      jsonLdTexts: [],
      origin: TY,
      query: "iPhone 16 Pro",
      checkedAt: now,
    });
    expect(r.products[0].productUrl).toBeNull();
  });

  it("gomulu nesne yoksa JSON-LD'ye duser (Hepsiburada)", () => {
    const ld = JSON.stringify({
      "@type": "ItemList",
      itemListElement: [
        {
          item: {
            "@type": "Product",
            name: "Apple iPhone 16 Pro 128 GB",
            url: "https://www.hepsiburada.com/apple-iphone-16-pro-p-X",
            image: "https://img.test/h.jpg",
            offers: {
              price: "64999.00",
              priceCurrency: "TRY",
              availability: "https://schema.org/InStock",
            },
          },
        },
      ],
    });
    const r = extractFromPage({
      scriptTexts: [],
      jsonLdTexts: [ld],
      origin: "https://www.hepsiburada.com",
      query: "iPhone 16 Pro",
      checkedAt: now,
    });
    expect(r.source).toBe("json-ld");
    expect(r.products[0]).toMatchObject({
      merchant: "Hepsiburada",
      priceKurus: 6_499_900,
      availability: "in_stock",
    });
  });
});

// Canli testte (2026-10-12) gorulen baslik kaliplari; veri sentetik.
describe("canli testte gorulen kaliplar", () => {
  const q = "iPhone 16 Pro";
  it("Turkce ekli ve Ingilizce aksesuar basliklarini eler", () => {
    expect(matchTitle("KVK iPhone 16 Pro Desenli Silikon Telefon Kılıfı", q)).toBe(false);
    expect(matchTitle("Fibaks Apple iPhone 16 Pro Kolay Uygulama Aparatlı Ekran Koruyucu", q)).toBe(
      false,
    );
    expect(matchTitle("Apple iPhone 16 Pro Silicone Case With Magsafe - Denim", q)).toBe(false);
    expect(matchTitle("Apple iPhone 16 Pro 128GB Çöl Titanyum", q)).toBe(true);
  });
  it("kaynak kategorisi aksesuar ya da yenilenmis ise eler", () => {
    expect(matchTitle("Apple iPhone 16 Pro Siyah", q, "Kapak & Kılıf")).toBe(false);
    expect(matchTitle("Apple iPhone 16 Pro 128GB", q, "Yenilenmiş Cep Telefonu")).toBe(false);
    expect(matchTitle("Apple iPhone 16 Pro 128GB", q, "IOS Cep Telefonları")).toBe(true);
  });
  it("sorgu aksesuar istiyorsa aksesuari dondurur", () => {
    expect(matchTitle("Apple iPhone 16 Pro 128GB Siyah", "iPhone 16 Pro kılıf")).toBe(false);
    expect(matchTitle("iPhone 16 Pro Kılıf Siyah", "iPhone 16 Pro kılıf")).toBe(true);
  });
});

describe("Hepsiburada reduxStore", () => {
  it("gomulu ItemList metnini okur ve sayisal fiyati kurusa cevirir", () => {
    const items = [
      {
        "@type": "ListItem",
        item: {
          "@type": "Product",
          name: "Apple iPhone 16 Pro 128GB Siyah",
          url: "https://www.hepsiburada.com/apple-iphone-16-pro-128gb-siyah-p-HBCVX",
          image: ["https://productimages.test/1.jpg"],
          offers: {
            price: 119499,
            priceCurrency: "TRY",
            availability: "https://schema.org/InStock",
          },
        },
      },
      {
        "@type": "ListItem",
        item: {
          "@type": "Product",
          name: "Apple iPhone 16 Pro Silicone Case With Magsafe",
          url: "https://www.hepsiburada.com/case-p-HBCVY",
          offers: { price: 1749, priceCurrency: "TRY" },
        },
      },
    ];
    const reduxStoreText = JSON.stringify({
      voltranState: {
        fragmentsMap: {
          99: { ProductList: { seoState: { itemListElement: JSON.stringify(items) } } },
        },
      },
    });
    const r = extractFromPage({
      scriptTexts: [],
      jsonLdTexts: [],
      reduxStoreText,
      origin: "https://www.hepsiburada.com",
      query: "iPhone 16 Pro",
      checkedAt: now,
    });
    expect(r.source).toBe("hepsiburada-redux-itemlist");
    expect(r.totalOnPage).toBe(2);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]).toMatchObject({
      priceKurus: 11_949_900,
      price: "119.499,00",
      availability: "in_stock",
      productUrl: "https://www.hepsiburada.com/apple-iphone-16-pro-128gb-siyah-p-HBCVX",
    });
  });
});
