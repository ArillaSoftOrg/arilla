import { describe, expect, it } from "vitest";
import {
  alertSizeNormForVariant,
  buildPriceComparison,
  type OfferInput,
  parseQuantity,
  quantityKey,
  unitPriceKurus,
  type VariantInput,
} from "./variant-price.ts";

function row(label: string, priceKurus: number, inStock = true): VariantInput {
  return { label, sizeNorm: label.toLowerCase(), priceKurus, inStock, fromVariantRow: true };
}

function offer(
  offerId: number,
  merchantName: string,
  variants: VariantInput[],
  extra: Partial<OfferInput> = {},
): OfferInput {
  const cheapest = Math.min(...variants.map((v) => v.priceKurus));
  return {
    offerId,
    merchantName,
    merchantTrustScore: 50,
    currentPrice: cheapest,
    listPrice: null,
    shippingCost: 0,
    freeShippingThreshold: null,
    inStock: variants.some((v) => v.inStock),
    variants,
    ...extra,
  };
}

/** Gercek veri: urun 11023, Dr. Althea Rapid Hypochlorous Acid Rescue Mist. */
const KORENDY = offer(14078, "Korendy", [row("60ml", 67_000), row("100ml", 111_800)]);
const VIONINE_TITLE =
  "Dr. Althea Rapid Hypochlorous Acid Rescue Mist - Yatıştırıcı Yüz Misti 100 ml";
const VIONINE = offer(18192, "Vionine", [
  {
    label: VIONINE_TITLE,
    sizeNorm: null,
    priceKurus: 170_900,
    inStock: true,
    fromVariantRow: false,
  },
]);

describe("parseQuantity", () => {
  it("reads one unit-bearing quantity and normalises units", () => {
    expect(parseQuantity("60ml")).toEqual({ amount: 60, unit: "ml", pack: 1 });
    expect(parseQuantity("Stanley Quencher 0.59 LT")).toEqual({ amount: 590, unit: "ml", pack: 1 });
    expect(parseQuantity("Reju Cream 20 gr")).toEqual({ amount: 20, unit: "g", pack: 1 });
    expect(parseQuantity("1,5 l")).toEqual({ amount: 1500, unit: "ml", pack: 1 });
  });

  it("keeps pack quantity distinct: 2 x 100 ml is not 100 ml", () => {
    const pack = parseQuantity("Tonik 2 x 100 ml");
    expect(pack).toEqual({ amount: 100, unit: "ml", pack: 2 });
    if (!pack) throw new Error("paket miktari okunmali");
    expect(quantityKey(pack)).toBe("2x100ml");
    expect(parseQuantity("Şampuan 400 ml 2'li")).toEqual({ amount: 400, unit: "ml", pack: 2 });
    const single = parseQuantity("Tonik 100 ml");
    if (!single) throw new Error("tek miktar okunmali");
    expect(quantityKey(single)).toBe("100ml");
  });

  it("never guesses from unit-less numbers or ambiguous multi-quantity titles", () => {
    expect(parseQuantity("Dr. Althea 345 Relief Cream")).toBeNull();
    expect(parseQuantity("Numbuzin No.9 Toner")).toBeNull();
    expect(parseQuantity("Set: Serum 50 ml + Krem 15 ml")).toBeNull();
    expect(parseQuantity("Mouse 3200 dpi")).toBeNull();
    expect(parseQuantity(null)).toBeNull();
  });
});

describe("unitPriceKurus", () => {
  it("is price per 100 ml only from a trustworthy quantity", () => {
    expect(unitPriceKurus(67_000, parseQuantity("60ml"))).toBe(111_667);
    expect(unitPriceKurus(111_800, parseQuantity("100ml"))).toBe(111_800);
    expect(unitPriceKurus(100_000, parseQuantity("2 x 100 ml"))).toBe(50_000);
    expect(unitPriceKurus(100_000, parseQuantity("345 Relief"))).toBeNull();
  });
});

describe("buildPriceComparison", () => {
  it("60 ml and 100 ml are not directly comparable: no silent 'cheapest' without a selection", () => {
    const result = buildPriceComparison([KORENDY, VIONINE], null);
    expect(result.mode).toBe("variants");
    if (result.mode !== "variants") return;
    expect(result.options.map((o) => o.key)).toEqual(["60ml", "100ml"]);
    expect(result.best).toBeNull();
    expect(result.startingPriceKurus).toBe(67_000);
  });

  it("100 ml across two merchants is comparable; selected 100 ml never links to 60 ml", () => {
    const result = buildPriceComparison([KORENDY, VIONINE], "100ml");
    if (result.mode !== "variants") throw new Error("variants beklendi");
    expect(result.rows.map((r) => [r.merchantName, r.priceKurus])).toEqual([
      ["Korendy", 111_800],
      ["Vionine", 170_900],
    ]);
    expect(result.best?.offerId).toBe(14078);
    expect(result.best?.variantKey).toBe("100ml");
    expect(result.rows.every((r) => r.variantKey === "100ml")).toBe(true);
  });

  it("variant-specific cheapest: selecting 60 ml excludes the 100-ml-only listing", () => {
    const result = buildPriceComparison([KORENDY, VIONINE], "60ml");
    if (result.mode !== "variants") throw new Error("variants beklendi");
    expect(result.rows.map((r) => r.offerId)).toEqual([14078]);
    expect(result.best?.priceKurus).toBe(67_000);
  });

  it("list price (savings) only applies to the variant it belongs to", () => {
    const discounted = { ...KORENDY, listPrice: 80_000 };
    const at60 = buildPriceComparison([discounted, VIONINE], "60ml");
    const at100 = buildPriceComparison([discounted, VIONINE], "100ml");
    if (at60.mode !== "variants" || at100.mode !== "variants") throw new Error();
    expect(at60.best?.listPriceKurus).toBe(80_000);
    // 80.000 liste fiyati 60 ml'nin; 100 ml icin "tasarruf" uretmez.
    expect(at100.best?.listPriceKurus).toBeNull();
  });

  it("missing selected variant is reported, not silently replaced", () => {
    const result = buildPriceComparison([KORENDY, VIONINE], "200ml");
    if (result.mode !== "variants") throw new Error();
    expect(result.selectedKey).toBeNull();
    expect(result.selectedMissing).toBe(true);
    expect(result.best).toBeNull();
  });

  it("out-of-stock compatible offer is still the honest best when nothing compatible is in stock", () => {
    const korendyOut = offer(1, "Korendy", [
      row("60ml", 67_000, false),
      row("100ml", 111_800, false),
    ]);
    const result = buildPriceComparison([korendyOut, VIONINE], "100ml");
    if (result.mode !== "variants") throw new Error();
    // Vionine 100 ml stokta: stoktaki uyumlu teklif oncelikli.
    expect(result.best?.offerId).toBe(18192);
  });

  it("unit price is attached to rows with a reliable quantity", () => {
    const result = buildPriceComparison([KORENDY, VIONINE], "100ml");
    if (result.mode !== "variants") throw new Error();
    expect(result.rows[0]?.unitPriceKurus).toBe(111_800);
    expect(result.rows[0]?.unitLabel).toBe("100 ml");
  });

  it("simple product (no size/volume variants) keeps the old comparison", () => {
    const sofa = offer(1, "Normod", [
      {
        label: "Klem Üçlü Koltuk",
        sizeNorm: null,
        priceKurus: 6_243_000,
        inStock: true,
        fromVariantRow: false,
      },
    ]);
    const other = offer(2, "Diğer", [
      {
        label: "Klem Üçlü Koltuk",
        sizeNorm: null,
        priceKurus: 6_000_000,
        inStock: true,
        fromVariantRow: false,
      },
    ]);
    expect(buildPriceComparison([sofa, other], null)).toEqual({ mode: "simple" });
  });

  it("single-merchant shoe with one price for every size stays simple", () => {
    const shoe = offer(
      1,
      "Derimod",
      ["39", "40", "41", "42"].map((s) => row(s, 315_000)),
    );
    expect(buildPriceComparison([shoe], null)).toEqual({ mode: "simple" });
  });

  it("shoe sizes across merchants: selecting 42 compares only 42", () => {
    const a = offer(1, "A", [row("41", 300_000), row("42", 300_000)]);
    const b = offer(2, "B", [row("42", 280_000)]);
    const result = buildPriceComparison([a, b], "beden:42");
    if (result.mode !== "variants") throw new Error();
    expect(result.best?.offerId).toBe(2);
    expect(result.rows.map((r) => r.offerId)).toEqual([2, 1]);
  });

  it("option 'from' price prefers in-stock offers over an out-of-stock cheaper one", () => {
    const outOfStock = offer(1, "Korendy", [
      row("15ml", 46_000, false),
      row("30ml", 91_900, false),
    ]);
    const inStock = offer(2, "Vionine", [
      {
        label: "Serum 30ml",
        sizeNorm: null,
        priceKurus: 152_900,
        inStock: true,
        fromVariantRow: false,
      },
    ]);
    const result = buildPriceComparison([outOfStock, inStock], null);
    if (result.mode !== "variants") throw new Error();
    expect(result.options.find((o) => o.key === "30ml")?.minPriceKurus).toBe(152_900);
    expect(result.options.find((o) => o.key === "15ml")?.minPriceKurus).toBe(46_000);
  });
});

describe("card 'starting from' rule (0037)", () => {
  it("multi-price variants => starting-from; same key across stores => normal price", () => {
    // Kartlar urun sayfasiyla ayni kurali kullanir: mode === "variants".
    expect(buildPriceComparison([KORENDY, VIONINE], null).mode).toBe("variants");
    const a = offer(1, "A", [
      {
        label: "Termos 0.59 L",
        sizeNorm: null,
        priceKurus: 250_000,
        inStock: true,
        fromVariantRow: false,
      },
    ]);
    const b = offer(2, "B", [
      {
        label: "Termos 590 ml",
        sizeNorm: null,
        priceKurus: 240_000,
        inStock: true,
        fromVariantRow: false,
      },
    ]);
    expect(buildPriceComparison([a, b], null).mode).toBe("simple");
  });
});

describe("alertSizeNormForVariant (0037)", () => {
  it("selected variant restock alert uses the same resolved key as ?boyut=", () => {
    expect(alertSizeNormForVariant("100ml")).toBe("100ml");
    expect(alertSizeNormForVariant("2x100ml")).toBe("2x100ml");
    // Beden: eski beden alarmlariyla ayni `size_norm` degeri.
    expect(alertSizeNormForVariant("beden:42")).toBe("42");
  });
});
