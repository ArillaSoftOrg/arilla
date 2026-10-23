import type { TrendProductCard } from "@arilla/core";

/**
 * İstemciye giden ürün kartı (karar 0149): tarih ISO metin; görsel adresi yalnızca http(s),
 * aksi halde `null` ("görsel yok" kutusu). Hem sayfa hem arama action'ı aynı dönüşümü kullanır.
 */
export type TrendProductCardView = Omit<TrendProductCard, "priceUpdatedAt"> & {
  priceUpdatedAt: string | null;
};

export function toCardView(card: TrendProductCard): TrendProductCardView {
  return {
    ...card,
    imageUrl: card.imageUrl && /^https?:\/\//i.test(card.imageUrl) ? card.imageUrl : null,
    priceUpdatedAt: card.priceUpdatedAt ? card.priceUpdatedAt.toISOString() : null,
  };
}
