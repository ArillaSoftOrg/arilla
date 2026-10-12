/**
 * Ziyaretci tarayicisindan (eklentisiz) canli magaza aramasi - arastirma prototipi.
 * Bkz. docs/research/canli-arama-platformlari.md. Uretime bagli degildir.
 */

export type LiveStoreId = "hepsiburada" | "ciceksepeti";

export type LiveAvailability = "in_stock" | "out_of_stock" | "unknown";

export interface LiveProduct {
  store: LiveStoreId;
  title: string;
  /** Kurus cinsinden tamsayi (CLAUDE.md: fiyat asla float). */
  priceKurus: number;
  currency: "TRY";
  imageUrl: string;
  productUrl: string;
  /** Liste verisinde satici yoksa magaza adi. */
  merchant: string;
  availability: LiveAvailability;
  lastCheckedAt: string;
  /** Kaynagin kategori yolu (yalnizca CicekSepeti `categoryTree`); kategori kaniti icin. */
  categoryNames?: string[];
}

export interface LiveStore {
  id: LiveStoreId;
  origin: string;
  searchUrl(query: string): string;
  /** Arama sayfasi HTML'inden urunler. Alanlardan biri dogrulanamazsa urun atlanir. */
  extract(html: string, checkedAt: string): LiveProduct[];
  /** Arama sayfasinin kendi kategori faseti (HB: yalnizca ust duzey, ornegin "Telefon"). */
  extractCategoryFacet?(html: string): string[];
}
