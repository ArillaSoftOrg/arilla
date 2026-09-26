import { describe, expect, it } from "vitest";
import type { OfferVariantRow } from "./get-price-comparison.ts";
import {
  historySources,
  mergeVariantHistory,
  type OfferDay,
  type PriceEvent,
  variantLowestClaim,
} from "./variant-price-history.ts";

function row(
  offerId: number,
  title: string,
  variant?: { id: number; label: string; price?: number },
): OfferVariantRow {
  return {
    offer_id: String(offerId),
    title_raw: title,
    variant_id: variant ? String(variant.id) : null,
    size_label: variant?.label ?? null,
    size_norm: variant?.label ?? null,
    in_stock: true,
    price_override: variant?.price === undefined ? null : String(variant.price),
  };
}

/** Gercek sekil: Korendy 60+100 ml tek teklif, Vionine 100 ml ayri liste. */
const ROWS = [
  row(1, "Rescue Mist", { id: 11, label: "60ml", price: 67_000 }),
  row(1, "Rescue Mist", { id: 12, label: "100ml", price: 111_800 }),
  row(2, "Rescue Mist - Yüz Misti 100 ml"),
];

describe("historySources", () => {
  it("uses price_point only for single-variant offers, variant events for multi-size offers", () => {
    expect(historySources(ROWS, "100ml")).toEqual([
      { kind: "variants", offerId: 1, variantIds: [12] },
      { kind: "offer", offerId: 2 },
    ]);
    // 60 ml'yi yalnizca Korendy satar; Vionine 100 ml listesi hic katilmaz.
    expect(historySources(ROWS, "60ml")).toEqual([
      { kind: "variants", offerId: 1, variantIds: [11] },
    ]);
  });
});

describe("mergeVariantHistory", () => {
  // Korendy'nin price_point'i EN UCUZ varyanti (60 ml) tasir: 670 TL.
  const offerDays: OfferDay[] = [
    { offerId: 1, day: "2026-09-20", minPrice: 67_000 },
    { offerId: 1, day: "2026-09-21", minPrice: 67_000 },
    { offerId: 2, day: "2026-09-20", minPrice: 175_000 },
    { offerId: 2, day: "2026-09-21", minPrice: 170_900 },
  ];
  const events: PriceEvent[] = [
    { variantId: 12, price: 115_000, observedAt: "2026-09-20T08:00:00.000Z" },
    { variantId: 12, price: 111_800, observedAt: "2026-09-21T08:00:00.000Z" },
    { variantId: 11, price: 67_000, observedAt: "2026-09-20T08:00:00.000Z" },
  ];

  it("100 ml history never contains the 60 ml price", () => {
    const history = mergeVariantHistory(historySources(ROWS, "100ml"), offerDays, events);
    expect(history.points).toEqual([
      { date: "2026-09-20", minPriceKurus: 115_000 },
      { date: "2026-09-21", minPriceKurus: 111_800 },
    ]);
    expect(history.points.every((p) => p.minPriceKurus !== 67_000)).toBe(true);
    expect(history.complete).toBe(true);
  });

  it("does not synthesize days before the first variant event", () => {
    const lateEvents: PriceEvent[] = [
      { variantId: 12, price: 111_800, observedAt: "2026-09-21T08:00:00.000Z" },
    ];
    const history = mergeVariantHistory(
      [{ kind: "variants", offerId: 1, variantIds: [12] }],
      offerDays,
      lateEvents,
    );
    expect(history.points).toEqual([{ date: "2026-09-21", minPriceKurus: 111_800 }]);
  });

  it("marks history incomplete when a compatible offer has no trustworthy data", () => {
    const history = mergeVariantHistory(historySources(ROWS, "100ml"), offerDays, []);
    // Korendy 100 ml icin olay yok: yalnizca Vionine katiliyor.
    expect(history.contributingOfferCount).toBe(1);
    expect(history.compatibleOfferCount).toBe(2);
    expect(history.complete).toBe(false);
  });
});

describe("variantLowestClaim", () => {
  const today = new Date("2026-12-20T12:00:00Z");
  const fullSpan = {
    points: [
      { date: "2026-09-20", minPriceKurus: 120_000 },
      { date: "2026-12-20", minPriceKurus: 111_800 },
    ],
    compatibleOfferCount: 2,
    contributingOfferCount: 2,
    complete: true,
  };

  it("claims 'lowest in 90 days' only from complete, ~90-day, same-variant history", () => {
    expect(variantLowestClaim(fullSpan, 111_800, today)).toBe(true);
    expect(variantLowestClaim(fullSpan, 115_000, today)).toBe(false);
  });

  it("hides the claim when history is incomplete or too short", () => {
    expect(variantLowestClaim({ ...fullSpan, complete: false }, 100_000, today)).toBe(false);
    const short = { ...fullSpan, points: [{ date: "2026-12-10", minPriceKurus: 120_000 }] };
    expect(variantLowestClaim(short, 100_000, today)).toBe(false);
    expect(variantLowestClaim(fullSpan, null, today)).toBe(false);
  });
});

describe("mergeVariantHistory composition", () => {
  it("never shows a fake drop when a store joins the series later", () => {
    const sources = historySources(ROWS, "100ml");
    const days: OfferDay[] = [
      { offerId: 1, day: "2026-09-24", minPrice: 67_000 },
      { offerId: 1, day: "2026-09-26", minPrice: 67_000 },
      { offerId: 2, day: "2026-09-24", minPrice: 170_900 },
      { offerId: 2, day: "2026-09-26", minPrice: 170_900 },
    ];
    // Korendy 100 ml olaylari ancak 26.09'da basliyor.
    const events: PriceEvent[] = [
      { variantId: 12, price: 111_800, observedAt: "2026-09-26T08:00:00.000Z" },
    ];
    const history = mergeVariantHistory(sources, days, events);
    // 24.09'da yalnizca Vionine var: gun seriye girmez, sahte 1.709 -> 1.118 dususu yok.
    expect(history.points).toEqual([{ date: "2026-09-26", minPriceKurus: 111_800 }]);
  });
});
