import { describe, expect, it } from "vitest";
import type { ProductProbe } from "../search/search-explain.ts";
import { absenceReasons, ProductRefInputError, parseProductRef } from "./search-diagnostics.ts";

function probe(overrides: Partial<ProductProbe> = {}): ProductProbe {
  return {
    productId: 7,
    slug: "urun-7",
    title: "Ürün",
    offers: { total: 1, active: 1, activeOnActiveMerchant: 1, activeInStock: 1 },
    hasBestOffer: true,
    prefilterPass: true,
    text: { matched: 1, head: 0.9, relevance: 0.9, required: 1 },
    textGatePass: true,
    predicates: [
      { name: "category", pass: true },
      { name: "price_max", pass: true },
    ],
    priceStats: { present: true, listPriceInflated: false },
    inCandidates: true,
    hiddenByImageOf: null,
    rank: 3,
    total: 10,
    score: 0.5,
    factors: { relevance: 0.9, trust: 0.8, stock: 1, price: 0.7 },
    ...overrides,
  };
}

describe("parseProductRef", () => {
  it("kimlik ya da slug kabul eder, başka biçimi reddeder", () => {
    expect(parseProductRef("42")).toEqual({ id: 42 });
    expect(parseProductRef(" deri-canta-1 ")).toEqual({ slug: "deri-canta-1" });
    for (const bad of ["", "0", "a b", "x'; DROP", "<script>", "a".repeat(201), 5]) {
      expect(() => parseProductRef(bad)).toThrow(ProductRefInputError);
    }
  });
});

describe("absenceReasons — yalnızca ölçülen kanıt", () => {
  it("ilk sıralarda ise neden yok; limit altındaysa sırası söylenir", () => {
    expect(absenceReasons(probe(), "balanced", 20)).toEqual([]);
    const below = absenceReasons(probe({ rank: 31 }), "balanced", 20);
    expect(below.map((r) => r.code)).toEqual(["below_limit"]);
    expect(below[0]?.text).toContain("31.");
  });

  it("teklif durumu: hiç yok / aktif değil / mağaza pasif / sorgu koşulu", () => {
    const base = { rank: null, inCandidates: false, hasBestOffer: false };
    expect(
      absenceReasons(
        probe({
          ...base,
          offers: { total: 0, active: 0, activeOnActiveMerchant: 0, activeInStock: 0 },
        }),
        "balanced",
        20,
      )[0]?.code,
    ).toBe("no_offer");
    expect(
      absenceReasons(
        probe({
          ...base,
          offers: { total: 2, active: 0, activeOnActiveMerchant: 0, activeInStock: 0 },
        }),
        "balanced",
        20,
      )[0]?.code,
    ).toBe("no_active_offer");
    expect(
      absenceReasons(
        probe({
          ...base,
          offers: { total: 2, active: 1, activeOnActiveMerchant: 0, activeInStock: 0 },
        }),
        "balanced",
        20,
      )[0]?.code,
    ).toBe("merchant_inactive");
    expect(absenceReasons(probe(base), "balanced", 20)[0]?.code).toBe("offer_filter");
  });

  it("metin kapısı, ön filtre ve filtre ayrı ayrı raporlanır", () => {
    const reasons = absenceReasons(
      probe({
        rank: null,
        inCandidates: false,
        prefilterPass: false,
        textGatePass: false,
        text: { matched: 0, head: 0.2, relevance: 0.1, required: 1 },
        predicates: [
          { name: "category", pass: false },
          { name: "price_max", pass: true },
        ],
      }),
      "balanced",
      20,
    );
    expect(reasons.map((r) => r.code)).toEqual(["prefilter", "text_gate", "filter"]);
    expect(reasons[2]?.filter).toBe("category");
  });

  it("en iyi fırsatlar: fiyat istatistiği yok ya da şişik", () => {
    const base = { rank: null, inCandidates: false };
    expect(
      absenceReasons(
        probe({ ...base, priceStats: { present: false, listPriceInflated: null } }),
        "best_deal",
        20,
      ).map((r) => r.code),
    ).toEqual(["no_price_stats"]);
    expect(
      absenceReasons(
        probe({ ...base, priceStats: { present: true, listPriceInflated: true } }),
        "best_deal",
        20,
      ).map((r) => r.code),
    ).toEqual(["list_price_inflated"]);
    // Bizim seçtiklerimiz fiyat istatistiğine bakmaz: neden uydurulmaz.
    expect(
      absenceReasons(
        probe({ ...base, priceStats: { present: false, listPriceInflated: null } }),
        "balanced",
        20,
      ).map((r) => r.code),
    ).toEqual(["unexplained"]);
  });

  it("görsel tekilleştirme kanıtı", () => {
    const reasons = absenceReasons(
      probe({ rank: null, inCandidates: true, hiddenByImageOf: { productId: 9, title: "Diğer" } }),
      "balanced",
      20,
    );
    expect(reasons.map((r) => r.code)).toEqual(["image_duplicate"]);
    expect(reasons[0]?.text).toContain("#9");
  });
});
