import { describe, expect, it } from "vitest";
import { foreignHeadlineOffer, type ProductForeignOffer } from "./product-foreign-offers.ts";

const offer = (offerId: number): ProductForeignOffer => ({
  offerId,
  merchantName: "AliExpress",
  currency: "USD",
  priceMinor: 1999,
  listPriceMinor: null,
  priceObservedAt: new Date("2026-10-16T10:00:00Z"),
  approx: null,
});

describe("foreignHeadlineOffer (karar 0127)", () => {
  it("TL teklifi yoksa listenin ilk (en yeni gözlenen) yurt dışı teklifi başlığa çıkar", () => {
    expect(foreignHeadlineOffer(false, [offer(2), offer(1)])?.offerId).toBe(2);
  });

  it("TL teklifi varsa başlık TL'nindir: yurt dışı tutar TL ile yarışmaz", () => {
    expect(foreignHeadlineOffer(true, [offer(2)])).toBeNull();
  });

  it("hiç teklif yoksa başlık yok", () => {
    expect(foreignHeadlineOffer(false, [])).toBeNull();
  });
});
