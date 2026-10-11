import { describe, expect, it } from "vitest";

import { fetchBuyboxQuotes, type PostFetch, quotesFromBuyboxResponse } from "./trendyol-buybox.ts";
import type { AuthorizedSeller } from "./trendyol-seller-api.ts";

// SENTETIK; yanit bicimi belgedeki ornegi izler. Barkod 195949771569 ve contentId
// 857296094, 2026-10-12'de Trendyol urun sayfasinda goruldu.
const seller: AuthorizedSeller = {
  sellerId: "724838",
  displayName: "Akarsu İletişim",
  apiKey: "k",
  apiSecret: "s",
};
const catalog = [
  {
    contentId: "857296094",
    barcode: "195949771569",
    title: "Apple iPhone 16 Pro 128GB Çöl Titanyum",
    productUrl: null,
  },
  {
    contentId: "813659620",
    barcode: "4066765863348",
    title: "adidas Samba OG ID0478 36",
    productUrl: null,
  },
];
const NOW = new Date("2026-10-12T12:00:00Z");

describe("quotesFromBuyboxResponse", () => {
  const map = new Map(catalog.map((c) => [c.barcode, c]));
  it("buybox kazanani kendisiyse saticiyi yazar, degilse anonim birakir", () => {
    const r = quotesFromBuyboxResponse(
      {
        buyboxInfo: [
          {
            barcode: "195949771569",
            buyboxOrder: 1,
            buyboxPrice: 124999,
            hasMultipleSeller: false,
          },
          {
            barcode: "4066765863348",
            buyboxOrder: 3,
            buyboxPrice: 7199.1,
            hasMultipleSeller: true,
            secondBuyboxPrice: 7499,
          },
        ],
      },
      map,
      seller,
      NOW.toISOString(),
    );
    expect(r[0]).toMatchObject({
      storeProductId: "857296094",
      seller: "Akarsu İletişim",
      supplierId: "724838",
      priceKurus: 12_499_900,
      priceBasis: "buyboxPrice",
    });
    expect(r[1]).toMatchObject({
      storeProductId: "813659620",
      seller: null,
      supplierId: null,
      priceKurus: 719_910,
    });
  });
  it("katalog disi barkodu ve gecersiz fiyati atar", () => {
    const r = quotesFromBuyboxResponse(
      {
        buyboxInfo: [
          { barcode: "999", buyboxPrice: 1 },
          { barcode: "195949771569", buyboxPrice: "yok" },
        ],
      },
      map,
      seller,
      "t",
    );
    expect(r).toEqual([]);
  });
});

describe("fetchBuyboxQuotes", () => {
  it("yalnizca katalog barkodlarini 10'arli gruplarla POST eder; belgedeki uc nokta ve UA", async () => {
    const big = Array.from({ length: 23 }, (_, i) => ({
      contentId: String(i),
      barcode: `B${i}`,
      title: "x",
      productUrl: null,
    }));
    const bodies: string[][] = [];
    const urls: string[] = [];
    const fetchImpl: PostFetch = async (url, init) => {
      urls.push(url);
      expect(init.headers["user-agent"]).toBe("724838 - ManiCepte");
      bodies.push(JSON.parse(init.body).barcodes);
      return { status: 200, json: async () => ({ buyboxInfo: [] }) };
    };
    await fetchBuyboxQuotes(
      { seller, integratorName: "ManiCepte", fetchImpl, now: () => NOW },
      big,
    );
    expect(bodies.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(urls[0]).toBe(
      "https://apigw.trendyol.com/integration/product/sellers/724838/products/buybox-information",
    );
  });
  it("401/429'da durur, yeniden denemez", async () => {
    let n = 0;
    const fetchImpl: PostFetch = async () => {
      n++;
      return { status: 429, json: async () => ({}) };
    };
    const big = Array.from({ length: 30 }, (_, i) => ({
      contentId: String(i),
      barcode: `B${i}`,
      title: "x",
      productUrl: null,
    }));
    expect(
      await fetchBuyboxQuotes({ seller, integratorName: "ManiCepte", fetchImpl }, big),
    ).toEqual([]);
    expect(n).toBe(1);
  });
});
