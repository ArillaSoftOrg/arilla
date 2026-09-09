/**
 * `search()`, `findAlternatives()`, `compareMerchants()` icin ortak donus
 * tipleri. `types.ts`'in disari acik QueryObject sozlesmesine dokunmaz.
 */
import type { Intent, SortMode } from "./types.ts";

export interface SearchResultItem {
  productId: number;
  publicId: string;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  /** Secilen en iyi teklifin fiyati, kurus. */
  minPrice: number | null;
  brandName: string | null;
  categoryPath: string | null;
  /** Secilen en iyi teklifin merchant'inin trust_score'u. */
  merchantTrustScore: number | null;
  /** Secilen en iyi teklifin stok durumu. */
  inStock: boolean | null;
  currentPercentile: number | null;
  listPriceInflated: boolean;
  /** Sekmeye ozel siralama skoru - hata ayiklama ve test icin acik. */
  score: number;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  sort: SortMode;
}

export class UnsupportedSortForIntentError extends Error {
  constructor(intent: Intent, sort: SortMode) {
    super(
      `"${sort}" siralamasi gecersiz: "${intent}" intent'i icin tanimli bir similarity_edge.kind yok`,
    );
    this.name = "UnsupportedSortForIntentError";
  }
}

export interface AlternativeProduct {
  productId: number;
  publicId: string;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  brandName: string | null;
  similarityScore: number;
  similarityKind: "same" | "visual" | "semantic" | "substitute";
}

export interface MerchantOffer {
  offerId: number;
  merchantId: number;
  merchantSlug: string;
  merchantName: string;
  merchantTrustScore: number;
  currentPrice: number;
  listPrice: number | null;
  shippingCost: number | null;
  freeShippingThreshold: number | null;
  effectiveShipping: number;
  effectiveTotal: number;
  inStock: boolean;
  url: string;
}
