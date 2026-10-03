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
import { sql } from "drizzle-orm";
import { withStartingFrom } from "../product/get-price-comparison.ts";
import { arrayParam } from "./ranking.ts";
import {
  type SearchResult,
  type SearchResultItem,
  UnsupportedSortForIntentError,
} from "./result-types.ts";
import {
  bestOfferCte,
  buildFilterClause,
  distinctImage,
  finalOrder,
  merchantIdsOf,
  scoredCtes,
  type TextSort,
} from "./search-sql.ts";
import type { QueryObject } from "./types.ts";

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
  offer_count: number;
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
    offerCount: Number(row.offer_count),
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

/**
 * Metin sekmeleri: kapidan gecen urunler (`scoredCtes`), ayni gorselden tek
 * kart (`distinctImage`), sekmenin siralamasi. Yapi taslari `search-sql.ts`'te;
 * yonetim arama tanisi da onlari kullanir.
 */
async function searchByText(
  db: Database,
  query: QueryObject,
  sort: TextSort,
  limit: number,
  offset: number,
): Promise<SearchResult> {
  const result = await db.execute<RawRow>(sql`
    ${scoredCtes(query, sort)}
    SELECT s.*, count(*) OVER()::text AS total_count
    FROM (${distinctImage(sql`scored`)}) s
    ORDER BY ${finalOrder(sort)}
    LIMIT ${limit} OFFSET ${offset}
  `);
  return toResult(result.rows, sort);
}

async function searchByClosestMatch(
  db: Database,
  query: QueryObject,
  anchorProductId: number,
  kinds: readonly string[],
  limit: number,
  offset: number,
): Promise<SearchResult> {
  const merchantIds = merchantIdsOf(query.filters);
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
           pps.current_percentile, pps.list_price_inflated, p.offer_count,
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

  let result: SearchResult;
  if (query.sort === "closest_match") {
    const kinds = INTENT_KIND[query.intent];
    if (!kinds || query.anchor?.type !== "product") {
      throw new UnsupportedSortForIntentError(query.intent, query.sort);
    }
    result = await searchByClosestMatch(db, query, query.anchor.id, kinds, limit, offset);
  } else if (query.sort === "best_deal") {
    result = await searchByText(db, query, "best_deal", limit, offset);
  } else {
    result = await searchByText(db, query, "balanced", limit, offset);
  }
  // 0037: kart fiyati varyantlar arasi baslangic fiyatiysa isaretlenir.
  return { ...result, items: await withStartingFrom(db, result.items) };
}
