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
  /** docs/pages.md "Urun karti": foto, baslik, fiyat, magaza sayisi. */
  offerCount: number;
  /** Sekmeye ozel siralama skoru - hata ayiklama ve test icin acik. */
  score: number;
  /**
   * 0037: true ise `minPrice` varyantlar arasi BASLANGIC fiyatidir (60/100 ml
   * farkli fiyatli); kart "...'den baslayan" yazar.
   */
  priceFromVariants?: boolean;
  /**
   * Karar 0129: secilen teklif yurt disi (TRY disi) ise dolu. O zaman `minPrice`
   * TCMB kuruyla YAKLASIK kurustur; kart "yaklaşık" yazar ve orijinal tutari,
   * kur tarihiyle birlikte gosterir. TRY teklifte yoktur.
   */
  foreignPrice?: ForeignPrice;
  /** Secilen en iyi teklifin magazasi (karar 0131: kartta kaynak magaza). */
  merchantName?: string | null;
}

export interface ForeignPrice {
  /** Orijinal tutar, para biriminin alt birimi (cent). */
  originalMinor: number;
  currency: string;
  /** TCMB bulten tarihi, YYYY-MM-DD; guncel kur yoksa null (yaklasik TL yok). */
  fxDate: string | null;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  /**
   * Karar 0129: aday kumesi sinira ulasti; `total` gercek eslesme sayisinin alt
   * sinirdir ("1.000+ sonuc"). Yoksa `total` kesindir.
   */
  totalCapped?: boolean;
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
  /** 0037: bkz. `SearchResultItem.priceFromVariants`. */
  priceFromVariants?: boolean;
  /** Karar 0129: bkz. `SearchResultItem.foreignPrice`. */
  foreignPrice?: ForeignPrice;
  /** Karar 0131: bkz. `SearchResultItem.merchantName`. */
  merchantName?: string | null;
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
  /**
   * Kaynak stok bildirmedi (`attributes_raw.stock_state = "unknown"`; karar 0130 Hepsiburada,
   * 0118 Trendyol). `inStock` Hepsiburada'da temkinli false, Trendyol'da true'dur; arayuz ikisinde
   * de "stokta"/"stokta yok" YAZMAZ ve JSON-LD availability vermez.
   */
  stockUnknown?: boolean;
  url: string;
}
