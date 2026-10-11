import { describe, expect, it } from "vitest";

import { enrichPrice, type ProductCard } from "./price-enrichment.ts";
import {
  type AuthorizedSeller,
  type FetchLike,
  quotesFromApprovedResponse,
  trendyolSellerApiProvider,
} from "./trendyol-seller-api.ts";

// SENTETIK: yanit bicimi developers.trendyol.com "Onayli Urun v2" ornegini izler
// (content[].variants[].price{salePrice,listPrice,priceSeenByCustomer}, onSale,
// locked, stock.quantity, productUrl ...). Gercek satici verisi DEGILDIR.
const NOW = new Date("2026-10-12T12:00:00Z");
const akarsu: AuthorizedSeller = {
  sellerId: "724838",
  displayName: "Akarsu İletişim",
  apiKey: "test-key",
  apiSecret: "test-secret",
};
const other: AuthorizedSeller = { ...akarsu, sellerId: "1", displayName: "Diğer Satıcı" };

const body = (contentId: string, variants: Record<string, unknown>[]) => ({
  totalElements: 1,
  content: [
    { contentId: Number(contentId), title: "Apple iPhone 16 Pro 128GB Çöl Titanyum", variants },
  ],
});
const variant = (over: Record<string, unknown> = {}) => ({
  variantId: 1,
  supplierId: 724838,
  barcode: "194253123456",
  onSale: true,
  locked: false,
  archived: false,
  blacklisted: false,
  stock: { quantity: 5 },
  price: { salePrice: 127999, listPrice: 127999, priceSeenByCustomer: 124999 },
  productUrl:
    "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094?merchantId=724838",
  ...over,
});

const card: ProductCard = {
  store: "Trendyol",
  storeProductId: "857296094",
  title: "Apple iPhone 16 Pro 128GB Çöl Titanyum",
  productUrl: "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
  supplierId: "724838",
};

describe("quotesFromApprovedResponse", () => {
  it("satisa acik varyanttan kimlikli teklif uretir; fiyat alani secilebilir", () => {
    const sale = quotesFromApprovedResponse(
      body("857296094", [variant()]),
      akarsu,
      "857296094",
      NOW.toISOString(),
      "salePrice",
    );
    expect(sale[0]).toMatchObject({
      store: "Trendyol",
      seller: "Akarsu İletişim",
      supplierId: "724838",
      barcode: "194253123456",
      priceKurus: 12_799_900,
      priceBasis: "salePrice",
    });
    const seen = quotesFromApprovedResponse(
      body("857296094", [variant()]),
      akarsu,
      "857296094",
      NOW.toISOString(),
      "priceSeenByCustomer",
    );
    expect(seen[0]).toMatchObject({ priceKurus: 12_499_900, priceBasis: "priceSeenByCustomer" });
  });

  it("satista olmayan, kilitli, stoksuz ve baska contentId'li kayitlari atar", () => {
    const r = quotesFromApprovedResponse(
      body("857296094", [
        variant({ onSale: false }),
        variant({ locked: true }),
        variant({ stock: { quantity: 0 } }),
        variant({ price: { salePrice: "yok" } }),
      ]),
      akarsu,
      "857296094",
      NOW.toISOString(),
      "salePrice",
    );
    expect(r).toEqual([]);
    expect(
      quotesFromApprovedResponse(body("1", [variant()]), akarsu, "857296094", "t", "salePrice"),
    ).toEqual([]);
  });

  it("ondalikli fiyati float kullanmadan kurusa cevirir", () => {
    const r = quotesFromApprovedResponse(
      body("813659620", [variant({ price: { salePrice: 3999.5 } })]),
      akarsu,
      "813659620",
      "t",
      "salePrice",
    );
    expect(r[0]?.priceKurus).toBe(399_950);
  });
});

describe("trendyolSellerApiProvider", () => {
  it("belgedeki uc nokta, Basic auth ve User-Agent bicimini kullanir; bilinen saticiya gider", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status: 200, json: async () => body("857296094", [variant()]) };
    };
    const p = trendyolSellerApiProvider({
      sellers: [other, akarsu],
      integratorName: "ManiCepte",
      fetchImpl,
      now: () => NOW,
    });
    const quotes = await p.quotes(card);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://apigw.trendyol.com/integration/product/sellers/724838/products/approved?contentId=857296094&size=1",
    );
    expect(calls[0]?.headers["user-agent"]).toBe("724838 - ManiCepte");
    expect(calls[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from("test-key:test-secret").toString("base64")}`,
    );
    expect(quotes).toHaveLength(1);
  });

  it("401/403/429'da o satici icin fiyat vermez, yeniden denemez", async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n++;
      return { status: 401, json: async () => ({}) };
    };
    const p = trendyolSellerApiProvider({
      sellers: [akarsu],
      integratorName: "ManiCepte",
      fetchImpl,
    });
    expect(await p.quotes(card)).toEqual([]);
    expect(n).toBe(1);
  });

  it("enrichPrice ile: yetkili saticidan exact eslesmeli Trendyol fiyati", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      json: async () => body("857296094", [variant()]),
    });
    const p = trendyolSellerApiProvider({
      sellers: [akarsu],
      integratorName: "ManiCepte",
      fetchImpl,
      now: () => NOW,
    });
    const r = await enrichPrice(card, [p], { now: () => NOW.getTime() });
    expect(r.trendyolPrice).toMatchObject({
      seller: "Akarsu İletişim",
      confidence: "exact",
      priceKurus: 12_799_900,
    });
    expect(r.fallback).toBeNull();
  });
});

describe("enrichPrice satici onceligi", () => {
  it("kesifte gorulen saticinin teklifi, daha ucuz baska saticidan once gelir", async () => {
    const quotes = [
      { seller: "Diğer", supplierId: "1", priceKurus: 12_000_000 },
      { seller: "Akarsu İletişim", supplierId: "724838", priceKurus: 12_499_900 },
    ].map((q) => ({
      ...q,
      source: "t",
      store: "Trendyol",
      storeProductId: "857296094",
      title: card.title,
      currency: "TRY",
      checkedAt: NOW.toISOString(),
    }));
    const r = await enrichPrice(card, [{ name: "t", quotes: async () => quotes }], {
      now: () => NOW.getTime(),
    });
    expect(r.trendyolPrice?.supplierId).toBe("724838");
  });
});
