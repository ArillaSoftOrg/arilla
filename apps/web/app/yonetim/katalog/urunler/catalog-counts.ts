import {
  type AdminActor,
  countProductClassification,
  countProductQuality,
  type ProductClassificationCounts,
  type ProductQualityFilter,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * Üst paneldeki katalog sayıları yayındaki TÜM ürünleri tarar (2,7 M satırda
 * saniyeler). Her filtre değişiminde yeniden saymak yerine süreç içinde kısa
 * süre tutulur; sayfa bu yaşı ("en fazla 2 dk önce") açıkça yazar. Yetki her
 * istekte `requireCapability` ile ayrıca denetlenir; tutulan değer yalnızca
 * `catalog.read` sahiplerine gösterilen toplam sayılardır (kişisel veri yok).
 * Başarısız sayım tutulmaz: sonraki istek yeniden dener.
 */
export const CATALOG_COUNTS_TTL_MS = 2 * 60 * 1000;

export interface CatalogCounts {
  quality: Record<ProductQualityFilter | "total", number>;
  classification: ProductClassificationCounts;
  measuredAt: Date;
}

let entry: { at: number; value: Promise<CatalogCounts> } | null = null;

export function catalogCounts(actor: AdminActor, now = Date.now()): Promise<CatalogCounts> {
  if (entry && now - entry.at < CATALOG_COUNTS_TTL_MS) return entry.value;
  const db = getDatabase();
  const value = Promise.all([
    countProductQuality(db, actor),
    countProductClassification(db, actor),
  ]).then(([quality, classification]) => ({
    quality,
    classification,
    measuredAt: new Date(now),
  }));
  const current = { at: now, value };
  entry = current;
  value.catch(() => {
    if (entry === current) entry = null;
  });
  return value;
}

/** Testler için. */
export function resetCatalogCounts(): void {
  entry = null;
}
