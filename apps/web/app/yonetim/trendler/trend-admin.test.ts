/**
 * Koleksiyon yönetimi arayüzü (karar 0149) — birim. Kart uyarı etiketleri core'un her
 * uyarısını kapsar, "gösterilemez" kümesi core ile aynıdır, istemciye giden kart güvenli
 * görsel adresi ve ISO tarih taşır.
 */
import {
  BLOCKING_WARNINGS,
  type TrendProductCard,
  type TrendProductWarning,
  trendProductWarnings,
} from "@arilla/core";
import { describe, expect, it } from "vitest";
import { trendCurationLabel, trendProductWarningLabel } from "../format.ts";
import { toCardView } from "./card-view.ts";
import { BLOCKING_WARNING_KEYS } from "./trend-product-card.tsx";

const card: TrendProductCard = {
  id: 7,
  slug: "urun",
  title: "Ürün",
  brandName: null,
  imageUrl: "https://img.test.example/a.jpg",
  minPrice: 100,
  maxPrice: 1_000,
  offerCount: 1,
  inStockCount: 0,
  foreignOfferCount: 0,
  publicationState: "held",
  priceUpdatedAt: new Date("2026-10-01T00:00:00Z"),
  sourceMerchant: null,
  activeTryOffers: 1,
  freshTryOffers: 0,
  affiliateOffers: 0,
  maxPriceObservations: 1,
  showable: false,
  warnings: [],
};

describe("koleksiyon kartı", () => {
  it("core'un ürettiği her uyarının Türkçe etiketi var", () => {
    const all = new Set<TrendProductWarning>([
      ...trendProductWarnings(card, new Date("2026-10-24T00:00:00Z")),
      ...trendProductWarnings(
        { ...card, imageUrl: null, minPrice: null, maxPrice: null },
        new Date("2026-10-24T00:00:00Z"),
      ),
    ]);
    expect(all.size).toBe(9);
    for (const warning of all) {
      expect(trendProductWarningLabel(warning)).not.toBe(warning);
    }
  });

  it("gösterilemez kümesi core ile aynı", () => {
    expect([...BLOCKING_WARNING_KEYS].sort()).toEqual([...BLOCKING_WARNINGS].sort());
  });

  it("istemci kartı: yalnızca http(s) görsel, ISO tarih", () => {
    expect(toCardView(card)).toMatchObject({
      imageUrl: "https://img.test.example/a.jpg",
      priceUpdatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(toCardView({ ...card, imageUrl: "javascript:alert(1)" }).imageUrl).toBeNull();
    expect(toCardView({ ...card, imageUrl: "data:image/png;base64,AAAA" }).imageUrl).toBeNull();
    expect(toCardView({ ...card, priceUpdatedAt: null }).priceUpdatedAt).toBeNull();
  });

  it("tür etiketleri", () => {
    expect(trendCurationLabel("manual")).toBe("Elle seçilmiş");
    expect(trendCurationLabel("auto")).toBe("Otomatik");
  });
});
