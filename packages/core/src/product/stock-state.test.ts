import { describe, expect, it } from "vitest";
import { offerStockState } from "./stock-state.ts";
import { buildPriceComparison, type OfferInput } from "./variant-price.ts";

describe("offerStockState (karar 0130)", () => {
  it("stokta olan teklif available; bildirilen unknown stok iddiasi degildir (karar 0118)", () => {
    expect(offerStockState(true, null)).toBe("available");
    expect(offerStockState(true, "available")).toBe("available");
    expect(offerStockState(true, "unknown")).toBe("unknown");
  });

  it("stok bildirilmediyse unknown, aksi halde unavailable", () => {
    expect(offerStockState(false, "unknown")).toBe("unknown");
    expect(offerStockState(false, "unavailable")).toBe("unavailable");
    expect(offerStockState(false, null)).toBe("unavailable");
    expect(offerStockState(false, undefined)).toBe("unavailable");
  });
});

function offer(id: number, size: string, price: number, extra: Partial<OfferInput> = {}) {
  return {
    offerId: id,
    merchantName: `M${id}`,
    merchantTrustScore: 50,
    currentPrice: price,
    listPrice: null,
    shippingCost: null,
    freeShippingThreshold: null,
    inStock: false,
    variants: [
      {
        label: `Parfum ${size}`,
        sizeNorm: null,
        priceKurus: price,
        inStock: false,
        fromVariantRow: false,
      },
    ],
    ...extra,
  } satisfies OfferInput;
}

describe("varyant karsilastirmasinda bilinmeyen stok", () => {
  it("bilinmeyen stoklu secenek 'stokta yok' sayilmaz; en iyi satir ona gider", () => {
    const unknown = offer(1, "50 ml", 10_000, {
      stockUnknown: true,
      variants: [
        {
          label: "Parfum 50 ml",
          sizeNorm: null,
          priceKurus: 10_000,
          inStock: false,
          stockUnknown: true,
          fromVariantRow: false,
        },
      ],
    });
    const out = offer(2, "50 ml", 9_000);
    const other = offer(3, "100 ml", 15_000);
    const result = buildPriceComparison([unknown, out, other], "50ml");
    expect(result.mode).toBe("variants");
    if (result.mode !== "variants") return;
    const option = result.options.find((o) => o.key === "50ml");
    expect(option).toMatchObject({ inStock: false, stockUnknown: true });
    expect(result.best?.offerId).toBe(1);
    expect(result.rows.find((r) => r.offerId === 2)?.stockUnknown).toBe(false);
    const hundred = result.options.find((o) => o.key === "100ml");
    expect(hundred).toMatchObject({ inStock: false, stockUnknown: false });
  });
});
