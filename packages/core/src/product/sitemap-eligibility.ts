/**
 * docs/sitemap.md "Hangi sayfa haritaya girer". Bir ürün sayfası haritaya
 * girer (ve `noindex` almaz) ancak: en az 2 aktif teklifi varsa, YA DA tek
 * teklifi var ama en az 14 günlük fiyat geçmişi birikmişse; VE görseli ve
 * başlığı varsa; VE kategorisi `is_discoverable` ise.
 *
 * Aynı koşul iki yerden kullanılır - ürün sayfasının `noindex` kararı
 * (`generateMetadata`) ve ürün sitemap parçalarının sorgusu
 * (`listSitemapEligibleProducts`) - iki kopya birbirinden sapmasın diye
 * ham SQL koşulu burada tek bir yerde tanımlı.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

const MIN_OFFERS_FOR_SITEMAP = 2;
const MIN_PRICE_HISTORY_DAYS = 14;

/** `p` = product, `c` = category (LEFT JOIN, kategorisiz ürün asla uygun değildir). */
const ELIGIBILITY_CONDITION = sql`
  p.title IS NOT NULL
  AND p.primary_image_url IS NOT NULL
  AND c.is_discoverable IS TRUE
  AND (
    p.offer_count >= ${MIN_OFFERS_FOR_SITEMAP}
    OR (
      p.offer_count = 1
      AND EXISTS (
        SELECT 1 FROM offer o
        JOIN price_point pp ON pp.offer_id = o.id
        WHERE o.product_id = p.id
        GROUP BY o.id
        HAVING now() - MIN(pp.observed_at) >= (INTERVAL '1 day' * ${MIN_PRICE_HISTORY_DAYS})
      )
    )
  )
`;

/** docs/sitemap.md "Parçalama kuralları": dosya başına en fazla 50.000 URL. */
export const SITEMAP_PRODUCT_SHARD_SIZE = 50_000;

export async function isProductSitemapEligible(db: Database, productId: number): Promise<boolean> {
  const result = await db.execute<{ eligible: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM product p
      LEFT JOIN category c ON c.id = p.category_id
      WHERE p.id = ${productId} AND ${ELIGIBILITY_CONDITION}
    ) AS eligible
  `);
  return result.rows[0]?.eligible === true;
}

export interface SitemapProductEntry {
  slug: string;
  lastModified: Date;
}

/**
 * `docs/sitemap.md` "Parça numarası ürün ID aralığına göre sabittir": (minId,
 * maxId] parametreleri sayı bazlı sayfalama değil, kalıcı bir ID aralığıdır -
 * yeni ürünler eklendikçe önceki parçaların numarası kaymaz.
 */
export async function listSitemapEligibleProducts(
  db: Database,
  range: { minId: number; maxId: number },
): Promise<SitemapProductEntry[]> {
  const result = await db.execute<{ slug: string; updated_at: string }>(sql`
    SELECT p.slug, p.updated_at
    FROM product p
    LEFT JOIN category c ON c.id = p.category_id
    WHERE p.id > ${range.minId} AND p.id <= ${range.maxId} AND ${ELIGIBILITY_CONDITION}
    ORDER BY p.id ASC
  `);
  return result.rows.map((row) => ({ slug: row.slug, lastModified: new Date(row.updated_at) }));
}

/** Sitemap index'inin kaç parça linkleyeceğini belirlemek için. */
export async function maxSitemapProductId(db: Database): Promise<number> {
  const result = await db.execute<{ max: string | null }>(sql`SELECT max(id) AS max FROM product`);
  return Number(result.rows[0]?.max ?? 0);
}
