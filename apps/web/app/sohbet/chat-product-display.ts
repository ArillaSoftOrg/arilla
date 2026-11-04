import type { ForeignPrice } from "@arilla/core";
import { formatStartingPrice, formatTRY } from "@arilla/ui";
import { cardPriceProps } from "../ara/search-results.tsx";
import type { ChatToolProduct } from "./chat-product-model.ts";

/** Mevcut kartın fiyat/kaynak kurallarını seri hale getirir; istemciye işlev gitmez. */
export function chatToolProduct(item: {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  brandName: string | null;
  minPrice: number | null;
  offerCount?: number;
  priceFromVariants?: boolean;
  foreignPrice?: ForeignPrice;
  merchantName?: string | null;
}): ChatToolProduct {
  const price = cardPriceProps(item);
  return {
    productId: item.productId,
    slug: item.slug,
    title: item.title,
    imageUrl: item.primaryImageUrl,
    brand: item.brandName,
    displayPrice:
      price.priceLabel ??
      (price.minPrice === null
        ? "Fiyat mağazada"
        : price.priceFrom
          ? formatStartingPrice(price.minPrice)
          : formatTRY(price.minPrice)),
    ...(price.sourceLabel ? { sourceLabel: price.sourceLabel } : {}),
    meta: price.offerCountLabel?.(price.offerCount ?? 0) ?? "",
  };
}
