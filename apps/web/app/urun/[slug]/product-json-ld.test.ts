import { describe, expect, it } from "vitest";
import { type ProductJsonLdInput, productJsonLd } from "./product-json-ld.ts";

const BASE: ProductJsonLdInput = {
  slug: "deneme-urun",
  title: "Deneme ürün",
  brandName: "Marka",
  imageUrls: ["https://cdn.example/a.webp"],
  siteUrl: "https://manicepte.com",
  variantMode: null,
  merchantOffers: [],
};

describe("productJsonLd", () => {
  it("teklifsiz üründe Product basılmaz (Google offers/review/rating ister)", () => {
    expect(productJsonLd(BASE)).toBeNull();
    expect(
      productJsonLd({ ...BASE, variantMode: { selectedKey: "beden:m", rows: [] } }),
    ).toBeNull();
  });

  it("mağaza teklifleri: fiyat TL, para birimi, stok ve mutlak çıkış adresi", () => {
    const ld = productJsonLd({
      ...BASE,
      merchantOffers: [
        { offerId: 7, currentPrice: 129_990, inStock: true },
        { offerId: 8, currentPrice: 99_900, inStock: false, stockUnknown: true },
      ],
    });
    expect(ld).toMatchObject({
      "@type": "Product",
      name: "Deneme ürün",
      brand: { "@type": "Brand", name: "Marka" },
      url: "https://manicepte.com/urun/deneme-urun",
    });
    expect(ld?.offers).toEqual([
      {
        "@type": "Offer",
        price: "1299.90",
        priceCurrency: "TRY",
        availability: "https://schema.org/InStock",
        url: "https://manicepte.com/git/7?surface=structured_data",
      },
      {
        "@type": "Offer",
        price: "999.00",
        priceCurrency: "TRY",
        url: "https://manicepte.com/git/8?surface=structured_data",
      },
    ]);
  });

  it("seçimsiz varyant: AggregateOffer fiyat aralığı ve tekil teklif sayısı", () => {
    const ld = productJsonLd({
      ...BASE,
      variantMode: {
        selectedKey: null,
        rows: [
          { offerId: 1, priceKurus: 50_000, inStock: true },
          { offerId: 1, priceKurus: 70_000, inStock: true },
          { offerId: 2, priceKurus: 60_000, inStock: false },
        ],
      },
    });
    expect(ld?.offers).toEqual({
      "@type": "AggregateOffer",
      priceCurrency: "TRY",
      lowPrice: "500.00",
      highPrice: "700.00",
      offerCount: 2,
    });
  });

  it("seçili varyant: yalnızca o satırlar, etiketle", () => {
    const ld = productJsonLd({
      ...BASE,
      variantMode: {
        selectedKey: "beden:m",
        rows: [{ offerId: 3, priceKurus: 45_050, inStock: true, variantLabel: "M" }],
      },
    });
    expect(ld?.offers).toEqual([
      {
        "@type": "Offer",
        name: "M",
        price: "450.50",
        priceCurrency: "TRY",
        availability: "https://schema.org/InStock",
        url: "https://manicepte.com/git/3?surface=structured_data",
      },
    ]);
  });

  it("site adresi yoksa göreli url yazılmaz", () => {
    const ld = productJsonLd({
      ...BASE,
      siteUrl: null,
      imageUrls: [],
      merchantOffers: [{ offerId: 7, currentPrice: 100, inStock: true }],
    });
    expect(ld).not.toHaveProperty("url");
    expect(ld).not.toHaveProperty("image");
    expect(JSON.stringify(ld)).not.toContain('"url"');
  });
});
