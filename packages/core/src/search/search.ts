/**
 * `search()` — docs/search.md "Sıralama": uc sekmenin ucu de burada.
 * Istek yolunda model cagrisi yok; girdi zaten ayristirilmis `QueryObject`
 * (metin ayristirma C1'in isi, bu fonksiyon ona bagimli degil).
 *
 * `DISTINCT ON` CTE ham `sql` sablonuyla yazilir: Drizzle 0.45'te LATERAL
 * join builder'i yok, "urun basina en iyi teklif" adimi bu sekilde en
 * dogal karsiligini buluyor.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { arrayParam, balancedScoreExpr, relevanceExpr } from "./ranking.ts";
import {
  type SearchResult,
  type SearchResultItem,
  UnsupportedSortForIntentError,
} from "./result-types.ts";
import type { QueryFilters, QueryObject } from "./types.ts";

export interface SearchPagination {
  /** docs/search.md: "Varsayilan 24 sonuc". */
  limit?: number;
  offset?: number;
}

/** intent -> similarity_edge.kind (docs/search.md, "intent" tablosu). */
const INTENT_KIND: Partial<
  Record<QueryObject["intent"], readonly ("same" | "visual" | "semantic")[]>
> = {
  same_cheaper: ["same"],
  similar_cheaper: ["visual", "semantic"],
};

type RawRow = Record<string, unknown> & {
  id: string;
  public_id: string;
  slug: string;
  title: string;
  primary_image_url: string | null;
  brand_name: string | null;
  category_path: string | null;
  current_price: string | null;
  in_stock: boolean | null;
  trust_score: number | null;
  current_percentile: number | null;
  list_price_inflated: boolean | null;
  total_count: string;
  score: number;
};

function toResultItem(row: RawRow): SearchResultItem {
  return {
    productId: Number(row.id),
    publicId: row.public_id,
    slug: row.slug,
    title: row.title,
    primaryImageUrl: row.primary_image_url,
    minPrice: row.current_price === null ? null : Number(row.current_price),
    brandName: row.brand_name,
    categoryPath: row.category_path,
    merchantTrustScore: row.trust_score,
    inStock: row.in_stock,
    currentPercentile: row.current_percentile,
    listPriceInflated: row.list_price_inflated ?? false,
    score: row.score,
  };
}

function toResult(rows: RawRow[], sort: QueryObject["sort"]): SearchResult {
  return {
    items: rows.map(toResultItem),
    total: rows.length === 0 ? 0 : Number(rows[0]?.total_count ?? 0),
    sort,
  };
}

/** `best_offer`: urun basina en dusuk fiyatli aktif teklif. */
function bestOfferCte(inStockOnly: boolean, merchantIds: number[] | null): SQL {
  return sql`
    best_offer AS (
      SELECT DISTINCT ON (o.product_id)
        o.product_id, o.id AS offer_id, o.current_price, o.in_stock, o.merchant_id, m.trust_score
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id
      WHERE o.product_id IS NOT NULL
        AND o.is_active AND m.is_active
        AND (${arrayParam(merchantIds)}::bigint[] IS NULL OR o.merchant_id = ANY(${arrayParam(merchantIds)}::bigint[]))
        AND (NOT ${inStockOnly} OR o.in_stock)
      ORDER BY o.product_id, o.current_price ASC NULLS LAST
    )
  `;
}

/** docs/search.md filtre tablosu: her alan bir indekse karsilik gelir. */
function buildFilterClause(filters: QueryFilters): SQL {
  const categoryPath = filters.category_path ?? null;
  const colors = filters.color && filters.color.length > 0 ? filters.color : null;
  const priceMin = filters.price_min ?? null;
  const priceMax = filters.price_max ?? null;
  const sizeNorm = filters.size_norm ?? null;
  const brandInclude =
    filters.brand_include && filters.brand_include.length > 0 ? filters.brand_include : null;
  const brandExclude =
    filters.brand_exclude && filters.brand_exclude.length > 0 ? filters.brand_exclude : null;
  const inStockOnly = filters.in_stock_only ?? false;

  return sql`
    (${categoryPath}::text IS NULL OR c.path = ${categoryPath} OR c.path LIKE ${categoryPath} || '/%')
    AND (${arrayParam(colors)}::text[] IS NULL OR p.color = ANY(${arrayParam(colors)}::text[]))
    AND (${priceMin}::bigint IS NULL OR p.min_price >= ${priceMin})
    AND (${priceMax}::bigint IS NULL OR p.min_price <= ${priceMax})
    AND (${sizeNorm}::text IS NULL OR EXISTS (
      SELECT 1 FROM offer_variant ov
      WHERE ov.offer_id = bo.offer_id AND ov.size_norm = ${sizeNorm}
        AND (NOT ${inStockOnly} OR ov.in_stock)
    ))
    AND (${arrayParam(brandInclude)}::text[] IS NULL OR b.name_norm = ANY(${arrayParam(brandInclude)}::text[]))
    AND (${arrayParam(brandExclude)}::text[] IS NULL OR b.name_norm IS NULL OR NOT (b.name_norm = ANY(${arrayParam(brandExclude)}::text[])))
  `;
}

async function searchByBalanced(
  db: Database,
  query: QueryObject,
  limit: number,
  offset: number,
): Promise<SearchResult> {
  const merchantIds =
    query.filters.merchant_ids && query.filters.merchant_ids.length > 0
      ? query.filters.merchant_ids
      : null;
  const inStockOnly = query.filters.in_stock_only ?? false;
  const relevance = relevanceExpr(sql`p.title`, query.text);
  const score = balancedScoreExpr(
    relevance,
    sql`bo.trust_score`,
    sql`bo.in_stock`,
    sql`pps.current_percentile`,
  );

  const result = await db.execute<RawRow>(sql`
    WITH ${bestOfferCte(inStockOnly, merchantIds)}
    SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
           b.name AS brand_name, c.path AS category_path,
           bo.current_price, bo.in_stock, bo.trust_score,
           pps.current_percentile, pps.list_price_inflated,
           count(*) OVER()::text AS total_count,
           ${score} AS score
    FROM product p
    JOIN best_offer bo ON bo.product_id = p.id
    LEFT JOIN product_price_stats pps ON pps.product_id = p.id
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN category c ON c.id = p.category_id
    WHERE ${buildFilterClause(query.filters)}
    ORDER BY score DESC, p.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return toResult(result.rows, "balanced");
}

async function searchByBestDeal(
  db: Database,
  query: QueryObject,
  limit: number,
  offset: number,
): Promise<SearchResult> {
  const merchantIds =
    query.filters.merchant_ids && query.filters.merchant_ids.length > 0
      ? query.filters.merchant_ids
      : null;
  const inStockOnly = query.filters.in_stock_only ?? false;

  const result = await db.execute<RawRow>(sql`
    WITH ${bestOfferCte(inStockOnly, merchantIds)}
    SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
           b.name AS brand_name, c.path AS category_path,
           bo.current_price, bo.in_stock, bo.trust_score,
           pps.current_percentile, pps.list_price_inflated,
           count(*) OVER()::text AS total_count,
           (100 - COALESCE(pps.current_percentile, 100))::double precision AS score
    FROM product p
    JOIN best_offer bo ON bo.product_id = p.id
    JOIN product_price_stats pps ON pps.product_id = p.id
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN category c ON c.id = p.category_id
    WHERE pps.list_price_inflated = FALSE
      AND ${buildFilterClause(query.filters)}
    ORDER BY pps.current_percentile ASC NULLS LAST, p.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return toResult(result.rows, "best_deal");
}

async function searchByClosestMatch(
  db: Database,
  query: QueryObject,
  anchorProductId: number,
  kinds: readonly string[],
  limit: number,
  offset: number,
): Promise<SearchResult> {
  const merchantIds =
    query.filters.merchant_ids && query.filters.merchant_ids.length > 0
      ? query.filters.merchant_ids
      : null;
  const inStockOnly = query.filters.in_stock_only ?? false;

  const result = await db.execute<RawRow>(sql`
    WITH ${bestOfferCte(inStockOnly, merchantIds)},
    edges AS (
      SELECT (CASE WHEN product_a = ${anchorProductId} THEN product_b ELSE product_a END) AS other_id,
             max(score) AS score
      FROM similarity_edge
      WHERE kind = ANY(${arrayParam(kinds)}::text[]) AND (product_a = ${anchorProductId} OR product_b = ${anchorProductId})
      GROUP BY other_id
    )
    SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
           b.name AS brand_name, c.path AS category_path,
           bo.current_price, bo.in_stock, bo.trust_score,
           pps.current_percentile, pps.list_price_inflated,
           count(*) OVER()::text AS total_count,
           e.score::double precision AS score
    FROM product p
    JOIN edges e ON e.other_id = p.id
    LEFT JOIN best_offer bo ON bo.product_id = p.id
    LEFT JOIN product_price_stats pps ON pps.product_id = p.id
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN category c ON c.id = p.category_id
    WHERE p.id <> ${anchorProductId}
      AND ${buildFilterClause(query.filters)}
    ORDER BY e.score DESC, p.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return toResult(result.rows, "closest_match");
}

export async function search(
  db: Database,
  query: QueryObject,
  pagination: SearchPagination = {},
): Promise<SearchResult> {
  const limit = pagination.limit ?? 24;
  const offset = pagination.offset ?? 0;

  if (query.sort === "closest_match") {
    const kinds = INTENT_KIND[query.intent];
    if (!kinds || query.anchor?.type !== "product") {
      throw new UnsupportedSortForIntentError(query.intent, query.sort);
    }
    return searchByClosestMatch(db, query, query.anchor.id, kinds, limit, offset);
  }
  if (query.sort === "best_deal") {
    return searchByBestDeal(db, query, limit, offset);
  }
  return searchByBalanced(db, query, limit, offset);
}
