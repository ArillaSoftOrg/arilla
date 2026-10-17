import { describe, expect, it } from "vitest";
import type { SearchResultItem } from "../src/search/result-types.ts";
import { cardStats, readOnlyUrl } from "./search-probe.ts";

function item(over: Partial<SearchResultItem>): SearchResultItem {
  return {
    productId: 1,
    publicId: "p1",
    slug: "urun-1",
    title: "Urun",
    primaryImageUrl: "https://img.example/a.jpg",
    minPrice: 19900,
    brandName: "Marka",
    categoryPath: "elektronik/ses/kulaklik",
    merchantTrustScore: null,
    inStock: true,
    currentPercentile: null,
    listPriceInflated: false,
    offerCount: 1,
    score: 1,
    merchantName: "AliExpress",
    ...over,
  };
}

describe("readOnlyUrl", () => {
  it("salt okunur oturum secenegini bosluklari %20 ile kodlayarak ekler", () => {
    const url = readOnlyUrl("postgresql://u:p@db:5432/arilla");
    expect(url).toBe(
      "postgresql://u:p@db:5432/arilla?options=-c%20default_transaction_read_only%3Don%20-c%20statement_timeout%3D15000",
    );
    expect(url).not.toContain("+");
  });

  it("var olan sorgu parametrelerini ve options'i korur", () => {
    const url = readOnlyUrl(
      "postgresql://u:p@db/arilla?sslmode=disable&options=-c%20search_path%3Dpublic",
    );
    expect(url.startsWith("postgresql://u:p@db/arilla?sslmode=disable&options=")).toBe(true);
    const options = decodeURIComponent(url.split("options=")[1] ?? "");
    expect(options).toBe(
      "-c search_path=public -c default_transaction_read_only=on -c statement_timeout=15000",
    );
  });
});

describe("cardStats", () => {
  it("TL, kurla cevrilmis, yalniz yurt disi ve fiyatsiz kartlari ayirir", () => {
    const foreign = { originalMinor: 999, currency: "USD", fxDate: "2026-10-17" };
    const stats = cardStats(
      [
        item({}),
        item({ minPrice: 41000, foreignPrice: foreign }),
        item({ minPrice: null, foreignPrice: foreign, brandName: null }),
        item({ minPrice: null, categoryPath: null, primaryImageUrl: null, merchantName: "Baska" }),
      ],
      "AliExpress",
    );
    expect(stats).toEqual({
      items: 4,
      fromMerchant: 3,
      withPrice: 2,
      foreignConverted: 1,
      foreignPriceOnly: 1,
      noPrice: 1,
      withBrand: 3,
      withCategory: 3,
      withImage: 3,
    });
  });
});
