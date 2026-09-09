/**
 * Urun sayfasi icin disari acik tipler. `search/result-types.ts` deseniyle
 * ayni: DB satir sekli degil, cagiran kodun gordugu sozlesme.
 */

export interface ProductDetail {
  productId: number;
  publicId: string;
  slug: string;
  title: string;
  brandName: string | null;
  modelKey: string | null;
  color: string | null;
  primaryImageUrl: string | null;
  offerCount: number;
  inStockCount: number;
  priceUpdatedAt: Date | null;
}

export type SlugResolution =
  | { status: "found"; product: ProductDetail }
  | { status: "redirect"; canonicalSlug: string }
  | { status: "not_found" };

export interface ProductPriceStatsDetail {
  min30d: number | null;
  min90d: number | null;
  max90d: number | null;
  median90d: number | null;
  currentPercentile: number | null;
  dropCount90d: number | null;
  listPriceInflated: boolean;
  listPriceRaisedAt: Date | null;
}

export interface PriceHistoryPoint {
  date: string;
  minPriceKurus: number;
}

export interface ColorVariant {
  productId: number;
  slug: string;
  color: string | null;
  primaryImageUrl: string | null;
}

export interface SizeOption {
  sizeNorm: string;
  sizeLabel: string | null;
  inStock: boolean;
}
