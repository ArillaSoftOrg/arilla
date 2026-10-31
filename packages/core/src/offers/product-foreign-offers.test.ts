import { describe, expect, it } from "vitest";
import {
  foreignHeadlineOffer,
  foreignOfferTimeNotes,
  type ProductForeignOffer,
} from "./product-foreign-offers.ts";

const offer = (offerId: number): ProductForeignOffer => ({
  offerId,
  merchantName: "AliExpress",
  currency: "USD",
  priceMinor: 1999,
  listPriceMinor: null,
  priceObservedAt: new Date("2026-10-16T10:00:00Z"),
  priceChangedAt: new Date("2026-10-16T10:00:00Z"),
  lastSeenAt: new Date("2026-10-31T07:00:00Z"),
  sourceStatus: "current",
  approx: null,
});

describe("foreignOfferTimeNotes", () => {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  it("son fiyat kaydı ile kaynakta son görülmeyi ayrı satırlar olarak söyler", () => {
    expect(foreignOfferTimeNotes(offer(1), fmt)).toEqual([
      "Son fiyat kaydı 2026-10-16",
      "Kaynakta en son 2026-10-31 görüldü",
    ]);
  });

  it("son sürümde olmayan teklifi güncel diye sunmaz", () => {
    const notes = foreignOfferTimeNotes({ ...offer(1), sourceStatus: "not_current" }, fmt);
    expect(notes.at(-1)).toBe("Kaynağın son sürümünde yok; güncel olarak doğrulanamadı");
  });

  it("besleme üyeliği bilinmiyorsa eski ya da güncel iddiası eklenmez", () => {
    expect(foreignOfferTimeNotes({ ...offer(1), sourceStatus: "unknown" }, fmt)).toHaveLength(2);
  });

  it("fiyat kaydı yoksa yalnızca kaynakta görülme yazılır", () => {
    expect(foreignOfferTimeNotes({ ...offer(1), priceChangedAt: null }, fmt)).toEqual([
      "Kaynakta en son 2026-10-31 görüldü",
    ]);
  });
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
