import { describe, expect, it } from "vitest";
import { cardPriceProps, resultCountLabel } from "./search-results.tsx";

describe("cardPriceProps (karar 0129, 0131)", () => {
  it("TRY, tek magaza: magaza sayisi yerine kaynak magaza", () => {
    const props = cardPriceProps({ minPrice: 129_900, offerCount: 1, merchantName: "Hepsiburada" });
    expect(props.minPrice).toBe(129_900);
    expect(props.offerCountLabel?.(1)).toBe("Hepsiburada");
  });

  it("TRY, birden cok magaza: magaza sayisi", () => {
    const props = cardPriceProps({ minPrice: 129_900, offerCount: 3, merchantName: "Hepsiburada" });
    expect(props.offerCountLabel?.(3)).toBe("3 mağaza");
  });

  it("yurt disi, guncel kur var: yaklasik TL + orijinal tutar, kaynak magaza rozette", () => {
    const props = cardPriceProps({
      minPrice: 124_500,
      offerCount: 0,
      merchantName: "AliExpress",
      foreignPrice: { originalMinor: 3_000, currency: "USD", fxDate: "2026-10-16" },
    });
    expect(props.minPrice).toBeNull();
    expect(props.priceLabel).toContain("≈");
    expect(props.priceLabel).toContain("USD");
    expect(props.sourceLabel).toBe("Yurt dışı · AliExpress");
    expect(props.offerCountLabel?.(0)).toContain("16.10.2026");
  });

  it("yurt disi, kur yok: yalnizca orijinal tutar; yaklasik TL uydurulmaz", () => {
    const props = cardPriceProps({
      minPrice: null,
      offerCount: 0,
      merchantName: "AliExpress",
      foreignPrice: { originalMinor: 3_000, currency: "USD", fxDate: null },
    });
    expect(props.minPrice).toBeNull();
    expect(props.priceLabel).toContain("USD");
    expect(props.priceLabel).not.toContain("≈");
    expect(props.priceLabel).not.toContain("TL");
    expect(props.sourceLabel).toBe("Yurt dışı · AliExpress");
    expect(props.offerCountLabel?.(0)).toBe("Kargo ve vergi belirsiz");
  });
});

describe("resultCountLabel", () => {
  it("sinirli aday kumesinde toplam alt sinirdir", () => {
    expect(resultCountLabel(1000, true)).toBe("1.000+ sonuç");
    expect(resultCountLabel(14)).toBe("14 sonuç");
  });
});
