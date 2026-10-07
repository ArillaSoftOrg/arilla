import { type HistoryItemView, listHistory } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import type { SearchComposerRecentProduct } from "@arilla/ui";

/** "Alışverişe devam et" görünür ürün sayısı ("Son baktıkların" ile aynı kaynaktan, daha az). */
export const HOME_RECENT_PRODUCTS_LIMIT = 6;

/** `listHistory` satırı -> kart verisi. Ürün kimliği ve bağlantı `/hesap` ile aynı (`/urun/{slug}`). */
export function toRecentProducts(items: readonly HistoryItemView[]): SearchComposerRecentProduct[] {
  return items.map((item) => ({
    productId: item.productId,
    href: `/urun/${item.slug}`,
    title: item.title,
    imageUrl: item.primaryImageUrl,
    minPrice: item.minPrice,
    offerCount: item.offerCount,
  }));
}

/**
 * Ana sayfa sunucu tarafı yükleme: tek kaynak `product_view` (`listHistory`,
 * hesaptaki "Son baktıkların" ile ortak). Misafir -> DB'ye gitmez. Hata
 * sessizce boş liste olur (bölüm görünmez); loga yalnızca hata sınıfı düşer.
 */
export async function loadRecentProducts(
  userId: number | null,
): Promise<SearchComposerRecentProduct[]> {
  if (userId === null) return [];
  try {
    return toRecentProducts(await listHistory(getDatabase(), userId, HOME_RECENT_PRODUCTS_LIMIT));
  } catch (error) {
    console.warn(
      `[anasayfa] son bakilan urunler okunamadi, bolum atlandi (${error instanceof Error ? error.name : "unknown"})`,
    );
    return [];
  }
}
