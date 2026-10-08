/**
 * `/trendler` ve `/trendler/<slug>` okuma yolu (karar 0077). Istek yolu
 * yalnizca okur: baglari `services/ingest/curate` toplu isi yazar.
 *
 * Gosterilebilir urun = gorselli + fiyatli + stokta. Bu, curate'tan SONRA bir
 * urun stoktan dustuyse izgaranin kirik kart gostermemesi icin okuma aninda
 * uygulanir. Liste TEK toplu sorgu + TEK pencere sorgusudur (N+1 yok).
 */

import { type Database, trend as trendTable } from "@arilla/db";
import { and, eq, sql } from "drizzle-orm";
import { withStartingFrom } from "../product/get-price-comparison.ts";
import { heroCandidateUrls, resolveTrendHero } from "./hero.ts";
import { isTrendSchemaMissing, warnTrendSchemaMissing } from "./schema-guard.ts";
import { isTrendActiveNow } from "./sections.ts";
import {
  MIN_PUBLIC_TREND_PRODUCTS,
  TREND_THUMBNAIL_POOL,
  type TrendDetail,
  type TrendProductItem,
  type TrendSummary,
  type TrendThumbnail,
} from "./types.ts";

/** `product` takma adi `p` ile kullanilir. */
const SHOWABLE = sql.raw(
  "p.primary_image_url IS NOT NULL AND p.min_price > 0 AND p.in_stock_count > 0",
);

interface ListRow {
  id: string | number;
  slug: string;
  title: string;
  description: string;
  category: TrendSummary["category"];
  trend_type: TrendSummary["trendType"];
  featured: boolean;
  hero_image_url: string | null;
  active_from: Date | string | null;
  active_until: Date | string | null;
  product_count: string | number;
  starting_price: string | number | null;
}

interface ThumbRow {
  trend_id: string | number;
  product_id: string | number;
  title: string;
  brand_name: string | null;
  image_url: string;
}

interface ProductRow {
  product_id: string | number;
  slug: string;
  title: string;
  brand_name: string | null;
  primary_image_url: string | null;
  min_price: string | number | null;
  offer_count: number;
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** Yayinlanmis ve yeterli urunu olan trendler, `sort_order` sirasinda. */
async function loadPublicTrends(db: Database, now: Date = new Date()): Promise<TrendSummary[]> {
  const listed = await db.execute(sql`
    SELECT t.id, t.slug, t.title, t.description, t.category, t.trend_type, t.featured,
           t.hero_image_url, t.active_from, t.active_until,
           count(*) AS product_count, min(p.min_price) AS starting_price
      FROM trend t
      JOIN trend_product tp ON tp.trend_id = t.id
      JOIN product p ON p.id = tp.product_id AND ${SHOWABLE}
     WHERE t.status = 'published'
     GROUP BY t.id
    HAVING count(*) >= ${MIN_PUBLIC_TREND_PRODUCTS}
     ORDER BY t.sort_order, t.id
  `);
  const rows = listed.rows as unknown as ListRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((row) => Number(row.id));
  const thumbs = await db.execute(sql`
    SELECT x.trend_id, x.product_id, x.title, x.brand_name, x.image_url
      FROM (
        SELECT tp.trend_id, p.id AS product_id, p.title, b.name AS brand_name,
               p.primary_image_url AS image_url,
               row_number() OVER (PARTITION BY tp.trend_id ORDER BY tp.sort_order) AS rank
          FROM trend_product tp
          JOIN product p ON p.id = tp.product_id AND ${SHOWABLE}
          LEFT JOIN brand b ON b.id = p.brand_id
         WHERE tp.trend_id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})
      ) x
     WHERE x.rank <= ${TREND_THUMBNAIL_POOL}
     ORDER BY x.trend_id, x.rank
  `);
  const byTrend = new Map<number, TrendThumbnail[]>();
  for (const row of thumbs.rows as unknown as ThumbRow[]) {
    const key = Number(row.trend_id);
    const list = byTrend.get(key) ?? [];
    list.push({
      productId: Number(row.product_id),
      title: row.title,
      brandName: row.brand_name,
      imageUrl: row.image_url,
    });
    byTrend.set(key, list);
  }

  return rows.map((row) => {
    const thumbnails = byTrend.get(Number(row.id)) ?? [];
    const hero = resolveTrendHero(row.hero_image_url, thumbnails[0]?.imageUrl);
    return {
      heroCandidates: heroCandidateUrls(
        row.hero_image_url,
        thumbnails.map((thumb) => thumb.imageUrl),
      ),
      id: Number(row.id),
      slug: row.slug,
      title: row.title,
      description: row.description,
      category: row.category,
      trendType: row.trend_type,
      featured: row.featured,
      activeNow: isTrendActiveNow(
        {
          trendType: row.trend_type,
          activeFrom: toDate(row.active_from),
          activeUntil: toDate(row.active_until),
        },
        now,
      ),
      heroImageUrl: hero.url,
      heroSource: hero.source,
      productCount: Number(row.product_count),
      startingPrice: row.starting_price === null ? null : Number(row.starting_price),
      thumbnails,
    };
  });
}

/**
 * Tek trend + urun izgarasi. Yayinlanmamis, bulunamayan ya da
 * `MIN_PUBLIC_TREND_PRODUCTS`tan az gosterilebilir urunu olan trend icin
 * `null` (sayfa 404 verir). Sira: `trend_product.sort_order`.
 */
async function loadTrendBySlug(
  db: Database,
  slug: string,
  now: Date = new Date(),
): Promise<TrendDetail | null> {
  const [row] = await db
    .select()
    .from(trendTable)
    .where(and(eq(trendTable.slug, slug), eq(trendTable.status, "published")))
    .limit(1);
  if (!row) return null;

  const result = await db.execute(sql`
    SELECT p.id AS product_id, p.slug, p.title, b.name AS brand_name, p.primary_image_url,
           p.min_price, p.offer_count
      FROM trend_product tp
      JOIN product p ON p.id = tp.product_id AND ${SHOWABLE}
      LEFT JOIN brand b ON b.id = p.brand_id
     WHERE tp.trend_id = ${row.id}
     ORDER BY tp.sort_order
  `);
  const productRows = result.rows as unknown as ProductRow[];
  if (productRows.length < MIN_PUBLIC_TREND_PRODUCTS) return null;

  const products: TrendProductItem[] = await withStartingFrom(
    db,
    productRows.map((product) => ({
      productId: Number(product.product_id),
      slug: product.slug,
      title: product.title,
      brandName: product.brand_name,
      primaryImageUrl: product.primary_image_url,
      minPrice: product.min_price === null ? null : Number(product.min_price),
      offerCount: product.offer_count,
    })),
  ).then((items) => items.map((item) => ({ ...item, priceFromVariants: item.priceFromVariants })));

  const hero = resolveTrendHero(row.heroImageUrl, products[0]?.primaryImageUrl);
  const prices = products.flatMap((item) => (item.minPrice === null ? [] : [item.minPrice]));
  return {
    trend: {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      category: row.category,
      trendType: row.trendType,
      featured: row.featured,
      activeNow: isTrendActiveNow(row, now),
      heroImageUrl: hero.url,
      heroSource: hero.source,
      heroCandidates: heroCandidateUrls(
        row.heroImageUrl,
        products.map((item) => item.primaryImageUrl),
      ),
      productCount: products.length,
      startingPrice: prices.length > 0 ? Math.min(...prices) : null,
      thumbnails: products.slice(0, TREND_THUMBNAIL_POOL).flatMap((item) =>
        item.primaryImageUrl
          ? [
              {
                productId: item.productId,
                title: item.title,
                brandName: item.brandName,
                imageUrl: item.primaryImageUrl,
              },
            ]
          : [],
      ),
    },
    products,
  };
}

/**
 * Yayinlanmis ve yeterli urunu olan trendler, `sort_order` sirasinda. Trend
 * semasi henuz yoksa (0056 oncesi) bos liste doner ve uyari loglanir; baska
 * hatalar firlatilir.
 */
export async function getPublicTrends(
  db: Database,
  now: Date = new Date(),
): Promise<TrendSummary[]> {
  try {
    return await loadPublicTrends(db, now);
  } catch (error) {
    if (!isTrendSchemaMissing(error)) throw error;
    warnTrendSchemaMissing();
    return [];
  }
}

/** Tek trend + urun izgarasi; sema yoksa `null` (404). Bkz. `loadTrendBySlug`. */
export async function getTrendBySlug(
  db: Database,
  slug: string,
  now: Date = new Date(),
): Promise<TrendDetail | null> {
  try {
    return await loadTrendBySlug(db, slug, now);
  } catch (error) {
    if (!isTrendSchemaMissing(error)) throw error;
    warnTrendSchemaMissing();
    return null;
  }
}
