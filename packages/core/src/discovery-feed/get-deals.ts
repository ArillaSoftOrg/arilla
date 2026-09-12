/**
 * `/firsatlar` (docs/pages.md: "Fiyatı düşen ürünler, günlük üretilir. Her
 * kartta düşüş tutarı ve yüzdesi. list_price_inflated işaretli ürünler bu
 * listeden düşürülür"). `product_price_stats` zaten B5'in gecelik işinin
 * çıktısı - istek yolu yalnızca okur, yeniden hesaplamaz.
 *
 * Referans fiyat `median_90d`: bir ürünün "genelde ne kadar olduğu" -
 * `price_point`'ten düşüşün tam öncesi/sonrası anını yeniden inşa etmek
 * (şemada o alan yok) yerine, ürün sayfasındaki "Son 90 günün en düşüğü"
 * mesajıyla aynı 90 günlük çerçeveyi kullanır.
 */

import { type Database, product, productPriceStats } from "@arilla/db";
import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import type { DealItem } from "./types.ts";

/** "Günlük üretilir" - son 2 gün içindeki düşüşler, batch koşu saatindeki oynamaya tolerans. */
const RECENT_DROP_WINDOW_HOURS = 48;

export async function getDeals(db: Database, limit = 24): Promise<DealItem[]> {
  const since = new Date(Date.now() - RECENT_DROP_WINDOW_HOURS * 60 * 60 * 1000);

  const rows = await db
    .select({
      productId: product.id,
      slug: product.slug,
      title: product.title,
      primaryImageUrl: product.primaryImageUrl,
      currentPrice: product.minPrice,
      baselinePrice: productPriceStats.median90d,
    })
    .from(productPriceStats)
    .innerJoin(product, eq(product.id, productPriceStats.productId))
    .where(
      and(
        eq(productPriceStats.listPriceInflated, false),
        gte(productPriceStats.lastDropAt, since),
        gt(product.inStockCount, 0),
        sql`${product.minPrice} < ${productPriceStats.median90d}`,
      ),
    )
    .orderBy(desc(productPriceStats.lastDropAt))
    .limit(limit);

  return rows
    .filter(
      (row): row is typeof row & { currentPrice: number; baselinePrice: number } =>
        row.currentPrice !== null && row.baselinePrice !== null,
    )
    .map((row) => {
      const savingsKurus = row.baselinePrice - row.currentPrice;
      const savingsPercent = Math.round((savingsKurus / row.baselinePrice) * 100);
      return {
        productId: row.productId,
        slug: row.slug,
        title: row.title,
        primaryImageUrl: row.primaryImageUrl,
        currentPrice: row.currentPrice,
        baselinePrice: row.baselinePrice,
        savingsKurus,
        savingsPercent,
      };
    });
}
