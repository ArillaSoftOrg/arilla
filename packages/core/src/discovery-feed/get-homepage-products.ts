import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { offerVerifiedSql, productHasVerifiableOfferSql } from "../offers/freshness.ts";
import { withStartingFrom } from "../product/get-price-comparison.ts";

export interface HomepageProduct {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string;
  minPrice: number;
  offerCount: number;
  priceFromVariants?: boolean;
}

/**
 * Gunluk kesif secimi henuz hazir degilse gercek katalogdan kucuk bir vitrin.
 * Fiyat indeksiyle en fazla 1000 aday okunur; milyonluk katalog siralanmaz.
 * Yalnizca yayindaki, gorselli, fiyatli ve dogrulanabilir TRY teklifli urunler.
 * Kategori siralari ic ice gecerek tek bir kategorinin vitrini doldurmasini onler.
 * Gunun secimi deterministiktir; istek yolunda kayit/kurasyon yazilmaz.
 */
export async function getHomepageProducts(
  db: Database,
  day: string,
  limit = 12,
): Promise<HomepageProduct[]> {
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  const result = await db.execute<{
    id: string;
    slug: string;
    title: string;
    primary_image_url: string;
    min_price: string;
    offer_count: number;
  }>(sql`
    WITH priced AS MATERIALIZED (
      SELECT p.id, p.slug, p.title, p.primary_image_url, p.min_price,
             p.offer_count, p.category_id
      FROM product p
      WHERE p.min_price > 0 AND p.publication_state = 'published'
        AND p.offer_count > 0 AND p.primary_image_url IS NOT NULL
        AND ${productHasVerifiableOfferSql("p")}
        AND EXISTS (
          SELECT 1 FROM offer o JOIN merchant m ON m.id = o.merchant_id
          WHERE o.product_id = p.id AND o.is_active AND m.is_active
            AND o.currency = 'TRY' AND o.current_price > 0 AND o.in_stock
        )
      ORDER BY p.min_price ASC, p.id ASC
      LIMIT 1000
    ), ranked AS (
      SELECT p.*, md5(p.id::text || ${day}) AS daily_order,
             row_number() OVER (
               PARTITION BY p.category_id ORDER BY md5(p.id::text || ${day})
             ) AS category_rank
      FROM priced p LEFT JOIN category c ON c.id = p.category_id
      WHERE c.is_discoverable IS DISTINCT FROM FALSE
    ), chosen AS (
      SELECT * FROM ranked ORDER BY category_rank, daily_order LIMIT ${count}
    )
    SELECT p.id, p.slug, p.title, p.primary_image_url, bo.current_price AS min_price, p.offer_count
    FROM chosen p
    JOIN LATERAL (
      SELECT o.current_price FROM offer o JOIN merchant m ON m.id = o.merchant_id
      WHERE o.product_id = p.id AND o.is_active AND m.is_active
        AND o.currency = 'TRY' AND o.current_price > 0 AND o.in_stock
        AND ${offerVerifiedSql("o")}
      ORDER BY o.current_price, o.id LIMIT 1
    ) bo ON TRUE
    ORDER BY p.category_rank, p.daily_order
  `);
  return withStartingFrom(
    db,
    result.rows.map((row) => ({
      productId: Number(row.id),
      slug: row.slug,
      title: row.title,
      primaryImageUrl: row.primary_image_url,
      minPrice: Number(row.min_price),
      offerCount: Number(row.offer_count),
    })),
  );
}
