import { describe, expect, it } from "vitest";

import {
  enrichPrice,
  matchConfidence,
  modelCodes,
  type PriceProvider,
  type PriceQuote,
  type ProductCard,
} from "./price-enrichment.ts";

// Basliklar/fiyatlar 2026-10-12 canli gozlemlerinden (Trendyol liste JSON'u ve
// Akakce urun sayfasi, gercek Chrome). Saglayicilar sentetiktir.
const NOW = Date.parse("2026-10-12T12:00:00Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const iphone: ProductCard = {
  store: "Trendyol",
  storeProductId: "857296094",
  title: "Apple iPhone 16 Pro 128GB Çöl Titanyum",
  productUrl: "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
};
const samba: ProductCard = {
  store: "Trendyol",
  storeProductId: "813659620",
  title: "adidas Samba OG Bej Spor Ayakkabı (ID0478)",
  productUrl: "https://www.trendyol.com/adidas/samba-og-bej-spor-ayakkabi-id0478-p-813659620",
};

const q = (over: Partial<PriceQuote>): PriceQuote => ({
  source: "test",
  store: "Trendyol",
  storeProductId: null,
  title: "",
  seller: null,
  priceKurus: 1,
  currency: "TRY",
  checkedAt: at(10),
  ...over,
});

const provider = (quotes: PriceQuote[]): PriceProvider => ({
  name: "test",
  quotes: async () => quotes,
});

describe("modelCodes", () => {
  it("uretici kodlarini bulur, fiyat ve kimlik sayilarini almaz", () => {
    expect([...modelCodes("Adidas Samba OG ID0478 Bej-Siyah")]).toEqual(["id0478"]);
    expect([...modelCodes("Nike Air Force 1 07 CW2288-111 Beyaz")]).toEqual(["cw2288111"]);
    expect([...modelCodes("124.999 TL p-857296094")]).toEqual([]);
  });
});

describe("matchConfidence", () => {
  it("ayni magaza + ayni kimlik = exact", () => {
    expect(matchConfidence(iphone, q({ storeProductId: "857296094" }))).toBe("exact");
  });
  it("ortak model kodu = high (Akakce 'Samba OG ID0478' sayfasi)", () => {
    const quote = q({
      store: "Boyner",
      title: "Adidas Kadın Günlük Spor Ayakkabı Samba Og W Id0478",
    });
    expect(matchConfidence(samba, quote)).toBe("high");
  });
  it("Akakce'deki Trendyol satiri basliga gore medium", () => {
    const quote = q({
      title: "Apple iPhone 16 Pro 128GB Çöl Titanyum",
      seller: "Akarsu İletişim Teknoloji",
    });
    expect(matchConfidence(iphone, quote)).toBe("medium");
  });
  it("farkli depolama = low", () => {
    expect(matchConfidence(iphone, q({ title: "Apple iPhone 16 Pro 256GB Çöl Titanyum" }))).toBe(
      "low",
    );
  });
});

describe("enrichPrice", () => {
  it("Trendyol fiyatini yalnizca Trendyol teklifinden alir; digerleri ayri etiketlenir", async () => {
    const r = await enrichPrice(
      iphone,
      [
        provider([
          q({
            store: "idefix",
            title: "Apple iPhone 16 Pro 128 GB Çöl Titanyum",
            priceKurus: 11_875_000,
          }),
          q({
            title: "Apple iPhone 16 Pro 128GB Çöl Titanyum",
            priceKurus: 12_499_900,
            seller: "Akarsu İletişim Teknoloji",
          }),
        ]),
      ],
      { now: () => NOW },
    );
    expect(r.trendyolPrice).toMatchObject({
      store: "Trendyol",
      priceKurus: 12_499_900,
      confidence: "medium",
    });
    expect(r.otherStores.map((o) => o.store)).toEqual(["idefix"]);
    expect(r.fallback).toBeNull();
  });

  it("yalnizca baska magaza varsa Trendyol fiyati gostermez", async () => {
    const r = await enrichPrice(
      samba,
      [provider([q({ store: "Boyner", title: "Samba Og W Id0478", priceKurus: 438_000 })])],
      { now: () => NOW },
    );
    expect(r.trendyolPrice).toBeNull();
    expect(r.fallback).toBe("Fiyatı mağazada gör");
    expect(r.otherStores[0]).toMatchObject({ store: "Boyner", confidence: "high" });
  });

  it("eski, dusuk guvenli, TRY olmayan ve gecersiz fiyatlari atar; saglayici hatasi karti bozmaz", async () => {
    const failing: PriceProvider = {
      name: "x",
      quotes: async () => Promise.reject(new Error("403")),
    };
    const r = await enrichPrice(
      iphone,
      [
        failing,
        provider([
          q({ title: iphone.title, priceKurus: 1, checkedAt: at(60 * 48) }),
          q({ title: "Apple iPhone 16 Pro 256GB", priceKurus: 100 }),
          q({ title: iphone.title, priceKurus: 100, currency: "USD" }),
          q({ title: iphone.title, priceKurus: 0 }),
        ]),
      ],
      { now: () => NOW },
    );
    expect(r).toEqual({ trendyolPrice: null, otherStores: [], fallback: "Fiyatı mağazada gör" });
  });
});

describe("varyant celiskisi (canli gozlemler 2026-10-12)", () => {
  const sony: ProductCard = {
    store: "Trendyol",
    storeProductId: "312097758",
    title: "Sony Wh-1000xm5 Tamamen Kablosuz Gürültü Engelleme Özellikli Kulaklık-siyah",
    productUrl: "https://www.trendyol.com/sony/wh-1000xm5-siyah-p-312097758",
  };
  it("ayni model, farkli renk -> low (Siyah 23.949 vs Mavi 16.999)", () => {
    const mavi = q({
      storeProductId: "802022106",
      title: "Sony Wh-1000xm5 Tamamen Kablosuz … Kulaklık-Mavi",
    });
    expect(matchConfidence(sony, mavi)).toBe("low");
  });
  it("ayni contentId, farkli beden -> low; ayni beden -> exact", () => {
    const card: ProductCard = { ...samba, variant: "38,5" };
    expect(
      matchConfidence(card, q({ storeProductId: "813659620", title: samba.title, variant: "36" })),
    ).toBe("low");
    expect(
      matchConfidence(
        card,
        q({ storeProductId: "813659620", title: samba.title, variant: "38.5" }),
      ),
    ).toBe("exact");
  });
  it("ayni barkod her zaman exact (barkod varyant basinadir)", () => {
    const card: ProductCard = { ...samba, variant: "38,5", barcode: "4066765863256" };
    expect(
      matchConfidence(
        card,
        q({ store: "Boyner", barcode: "4066765863256", title: "x", variant: "38.5" }),
      ),
    ).toBe("exact");
  });
  it("renk bilgisi tek tarafta varsa celiski sayilmaz", () => {
    expect(
      matchConfidence(sony, q({ storeProductId: "312097758", title: "Sony WH-1000XM5" })),
    ).toBe("exact");
  });
});
