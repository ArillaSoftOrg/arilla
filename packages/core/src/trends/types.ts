import type { TrendCategory, TrendType } from "@arilla/db";

/**
 * Bir trendin /trendler'de ve adresinde gorunmesi icin gereken en az urun.
 * Daha azi "bozuk izgara" olur; urun uydurup doldurmak yerine trend gizlenir
 * (detay adresi 404). Esik kod sabitidir, DB'ye gitmez.
 */
export const MIN_PUBLIC_TREND_PRODUCTS = 4;

/** Kart onizlemesindeki kucuk urun gorseli sayisi. */
export const TREND_THUMBNAIL_COUNT = 4;

export type TrendHeroSource = "trend" | "product" | "placeholder";

export interface TrendThumbnail {
  productId: number;
  title: string;
  brandName: string | null;
  imageUrl: string;
}

/** `/trendler` kartinin tum verisi; tek okuma yolundan gelir. */
export interface TrendSummary {
  id: number;
  slug: string;
  title: string;
  description: string;
  category: TrendCategory;
  trendType: TrendType;
  featured: boolean;
  /** Mevsimlik/kampanya trendi ve `active_from <= now < active_until` (bos uc = sinirsiz). */
  activeNow: boolean;
  /** Cozulmus kapak: trend gorseli -> temsilci urun gorseli -> null (yer tutucu). */
  heroImageUrl: string | null;
  heroSource: TrendHeroSource;
  /** Gosterilebilir (gorselli, fiyatli, stokta) urun sayisi. */
  productCount: number;
  /** Kurus; gosterilebilir urunlerin en dusuk `min_price`'i. */
  startingPrice: number | null;
  thumbnails: TrendThumbnail[];
}

export interface TrendProductItem {
  productId: number;
  slug: string;
  title: string;
  brandName: string | null;
  primaryImageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
  /** 0037: kart fiyati varyantlar arasi baslangic fiyati mi. */
  priceFromVariants: boolean;
}

export interface TrendDetail {
  trend: TrendSummary;
  products: TrendProductItem[];
}
