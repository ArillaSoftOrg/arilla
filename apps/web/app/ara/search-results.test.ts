import { describe, expect, it } from "vitest";
import { cardPriceProps } from "./search-results.tsx";

describe("cardPriceProps - yurt dışı teklif (karar 0129/0132)", () => {
  it("TL ürün: fiyat ve mağaza sayısı aynen", () => {
    expect(cardPriceProps({ minPrice: 150_000, offerCount: 2 })).toMatchObject({
      minPrice: 150_000,
      offerCount: 2,
    });
  });

  it("kur varsa yaklaşık TL ve orijinal tutar birlikte, kur tarihiyle", () => {
    const props = cardPriceProps({
      minPrice: 124_500,
      offerCount: 0,
      foreignPrice: { originalMinor: 3_000, currency: "USD", fxDate: "2026-10-16" },
    });
    expect(props.minPrice).toBeNull();
    expect(props.priceLabel).toContain("30,00 USD");
    expect(props.priceLabel).toContain("≈");
    expect(props.sourceLabel).toBe("Yurt dışı");
    expect(props.offerCountLabel?.(0)).toContain("16.10.2026");
  });

  it("kur yoksa yalnızca kendi para birimi: TL yazılmaz, kur uydurulmaz", () => {
    const props = cardPriceProps({
      minPrice: null,
      offerCount: 0,
      foreignPrice: { originalMinor: 3_000, currency: "USD", fxDate: null },
    });
    expect(props.minPrice).toBeNull();
    expect(props.priceLabel).toBe("30,00 USD");
    expect(props.priceLabel).not.toContain("TL");
    expect(props.sourceLabel).toBe("Yurt dışı");
    expect(props.offerCountLabel?.(0)).toBe(
      "TL karşılığı için güncel kur yok · Kargo ve vergi belirsiz",
    );
  });
});
