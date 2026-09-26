import { describe, expect, it } from "vitest";
import { normalizeGtin, rankLinkCandidates, scoreCandidate } from "./link-ranking.ts";
import { parseLinkSource } from "./link-search.ts";

describe("rankLinkCandidates", () => {
  it("never calls a visually identical product the same product without identity evidence", () => {
    const ranked = rankLinkCandidates([[{ productId: 1, visual: 0.999, brandMatch: false }]], {
      hasImage: true,
      limit: 10,
    });
    expect(ranked.same).toEqual([]);
    expect(ranked.similar.map((c) => c.productId)).toEqual([1]);
  });

  it("puts identity matches in the same-product group", () => {
    const ranked = rankLinkCandidates(
      [
        [{ productId: 7, visual: 0.4, brandMatch: false }],
        [{ productId: 7, brandMatch: true, identity: "gtin" }],
        [{ productId: 8, visual: 0.9, brandMatch: false }],
      ],
      { hasImage: true, limit: 10 },
    );
    expect(ranked.same.map((c) => [c.productId, c.identity])).toEqual([[7, "gtin"]]);
    expect(ranked.similar.map((c) => c.productId)).toEqual([8]);
  });

  it("merges signals from different lists for the same product", () => {
    const ranked = rankLinkCandidates(
      [
        [
          { productId: 1, visual: 0.8, brandMatch: false },
          { productId: 2, visual: 0.82, brandMatch: false },
        ],
        [{ productId: 1, text: 0.6, brandMatch: true }],
      ],
      { hasImage: true, limit: 10 },
    );
    // Görselde biraz geride ama metin + marka eşleşen ürün öne geçer.
    expect(ranked.similar.map((c) => c.productId)).toEqual([1, 2]);
    expect(ranked.similar[0]?.text).toBe(0.6);
    expect(ranked.similar[0]?.brandMatch).toBe(true);
  });

  it("uses text weights when there is no image", () => {
    const candidate = { productId: 1, text: 0.5, brandMatch: true };
    expect(scoreCandidate(candidate, false)).toBeCloseTo(0.8 * 0.5 + 0.2);
    expect(scoreCandidate(candidate, true)).toBeCloseTo(0.25 * 0.5 + 0.1);
  });

  it("excludes the source product and respects the limit", () => {
    const ranked = rankLinkCandidates(
      [[1, 2, 3, 4].map((id) => ({ productId: id, visual: 1 - id / 10, brandMatch: false }))],
      { hasImage: true, limit: 2, excludeProductIds: [1] },
    );
    expect(ranked.similar.map((c) => c.productId)).toEqual([2, 3]);
  });
});

describe("normalizeGtin", () => {
  it("pads EAN-13 and UPC-12 to GTIN-14 so they compare", () => {
    expect(normalizeGtin("8680000000123")).toBe("08680000000123");
    expect(normalizeGtin("012345678905")).toBe(normalizeGtin("0012345678905"));
  });

  it("rejects values that are not barcodes", () => {
    expect(normalizeGtin("ABC")).toBeNull();
    expect(normalizeGtin("123")).toBeNull();
    expect(normalizeGtin(null)).toBeNull();
  });
});

describe("parseLinkSource", () => {
  it("keeps only fields that were present and well-typed", () => {
    const source = parseLinkSource({
      site: "magaza.example",
      title: "Deri Çanta",
      image_url: "https://cdn.magaza.example/c.jpg",
      price: 189990,
      currency: "TRY",
      extraction_layer: "json_ld",
    });
    expect(source).toMatchObject({
      site: "magaza.example",
      title: "Deri Çanta",
      brand: null,
      gtin: null,
      price: 189990,
      currency: "TRY",
      extractionLayer: "json_ld",
    });
  });

  it("drops a price without a currency and vice versa", () => {
    expect(parseLinkSource({ site: "a.example", price: 100 })?.price).toBeNull();
    expect(parseLinkSource({ site: "a.example", currency: "TRY" })?.currency).toBeNull();
    expect(parseLinkSource({ site: "a.example", price: 1.5, currency: "TRY" })?.price).toBeNull();
  });

  it("refuses non-http image urls", () => {
    expect(
      parseLinkSource({ site: "a.example", image_url: "javascript:alert(1)" })?.imageUrl,
    ).toBeNull();
    expect(
      parseLinkSource({ site: "a.example", image_url: "data:image/png;base64,xx" })?.imageUrl,
    ).toBeNull();
  });

  it("returns null for malformed rows", () => {
    expect(parseLinkSource(null)).toBeNull();
    expect(parseLinkSource([])).toBeNull();
    expect(parseLinkSource({ title: "site yok" })).toBeNull();
  });
});
