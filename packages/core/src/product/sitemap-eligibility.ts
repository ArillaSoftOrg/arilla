/**
 * docs/sitemap.md "Hangi sayfa haritaya girer". Bir ürün sayfası haritaya
 * girer (ve `noindex` almaz) ancak: en az 2 aktif mağazada teklifi varsa
 * (`offer_count`, karar 0072), YA DA tek mağazada teklifi var ama en az 14 günlük fiyat geçmişi birikmişse; VE görseli ve
 * başlığı varsa; VE kategorisi `is_discoverable` ise.
 *
 * Karar 0120 (fiyatsız ürün, varsayılan KAPALI): `SEO_UNPRICED_PRODUCTS_ENABLED=true` iken
 * doğrulanmış fiyatı olmayan ürün de girebilir, ancak YALNIZCA bilgi değeri açık kriterlerle
 * kanıtlanırsa: markası var, başlığı en az 15 karakter, en az 3 teknik özelliği var ve son
 * 14 günde kaynakta görülmüş aktif bir teklifi var (kaldırılan ürünün teklifi pasiftir, ürün
 * haritadan düşer ve `noindex` alır; sayfa yayında kalır). Yalnızca ad + görsel yetmez.
 *
 * Aynı koşul iki yerden kullanılır - ürün sayfasının `noindex` kararı
 * (`generateMetadata`) ve ürün sitemap parçalarının sorgusu
 * (`listSitemapEligibleProducts`) - iki kopya birbirinden sapmasın diye
 * ham SQL koşulu burada tek bir yerde tanımlı.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";

const MIN_OFFERS_FOR_SITEMAP = 2;
const MIN_PRICE_HISTORY_DAYS = 14;

/** Karar 0120: fiyatsız ürün için bilgi değeri eşikleri. */
export const UNPRICED_SITEMAP_RULES = {
  minTitleLength: 15,
  minAttributes: 3,
  maxOfferAgeDays: 14,
} as const;

/** Varsayılan kapalı; yalnızca açıkça `true`. */
export function isUnpricedIndexingEnabled(): boolean {
  return process.env.SEO_UNPRICED_PRODUCTS_ENABLED === "true";
}

/** `p` = product, `c` = category (LEFT JOIN, kategorisiz ürün asla uygun değildir). */
const COMMON_CONDITION = sql`
  p.title IS NOT NULL
  AND p.primary_image_url IS NOT NULL
  AND c.is_discoverable IS TRUE
`;

const PRICED_CONDITION = sql`
  (
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

const UNPRICED_CONDITION = sql`
  (
    p.offer_count = 0
    AND p.brand_id IS NOT NULL
    AND char_length(p.title) >= ${UNPRICED_SITEMAP_RULES.minTitleLength}
    AND (CASE WHEN jsonb_typeof(p.attributes) = 'object'
              THEN (SELECT count(*) FROM jsonb_object_keys(p.attributes))
              ELSE 0 END) >= ${UNPRICED_SITEMAP_RULES.minAttributes}
    AND EXISTS (
      SELECT 1 FROM offer o
      JOIN merchant m ON m.id = o.merchant_id
      WHERE o.product_id = p.id AND o.is_active AND m.is_active
        AND o.last_seen_at >= now() - (INTERVAL '1 day' * ${UNPRICED_SITEMAP_RULES.maxOfferAgeDays})
    )
  )
`;

function eligibilityCondition(): SQL {
  return isUnpricedIndexingEnabled()
    ? sql`${COMMON_CONDITION} AND (${PRICED_CONDITION} OR ${UNPRICED_CONDITION})`
    : sql`${COMMON_CONDITION} AND ${PRICED_CONDITION}`;
}

/** docs/sitemap.md "Parçalama kuralları": dosya başına en fazla 50.000 URL. */
export const SITEMAP_PRODUCT_SHARD_SIZE = 50_000;

export async function isProductSitemapEligible(db: Database, productId: number): Promise<boolean> {
  const result = await db.execute<{ eligible: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM product p
      LEFT JOIN category c ON c.id = p.category_id
      WHERE p.id = ${productId} AND ${eligibilityCondition()}
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
    WHERE p.id > ${range.minId} AND p.id <= ${range.maxId} AND ${eligibilityCondition()}
    ORDER BY p.id ASC
  `);
  return result.rows.map((row) => ({ slug: row.slug, lastModified: new Date(row.updated_at) }));
}

/** Sitemap index'inin kaç parça linkleyeceğini belirlemek için. */
export async function maxSitemapProductId(db: Database): Promise<number> {
  const result = await db.execute<{ max: string | null }>(sql`SELECT max(id) AS max FROM product`);
  return Number(result.rows[0]?.max ?? 0);
}

export interface SitemapShardEligibility {
  shard: number;
  eligible: number;
}

/**
 * Parça başına uygun ürün sayısı (`/yonetim/seo`). Aynı `eligibilityCondition()`
 * kullanılır; tanı ekranı sitemap'in gerçek davranışından sapamaz.
 */
export async function countSitemapEligibleByShard(
  db: Database,
): Promise<SitemapShardEligibility[]> {
  const result = await db.execute<{ shard: string; eligible: string }>(sql`
    SELECT ((p.id - 1) / ${SITEMAP_PRODUCT_SHARD_SIZE}) + 1 AS shard, count(*) AS eligible
    FROM product p
    LEFT JOIN category c ON c.id = p.category_id
    WHERE ${eligibilityCondition()}
    GROUP BY 1
    ORDER BY 1
  `);
  return result.rows.map((row) => ({ shard: Number(row.shard), eligible: Number(row.eligible) }));
}
