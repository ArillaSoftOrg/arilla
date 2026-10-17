/**
 * `findAlternatives()` — docs/pages.md, urun sayfasi "Alternatif seridi":
 * `similarity_edge`, 4-6 urun, yatay kaydirma. Sekme/siralama secimi yok -
 * ucu sekmenin tumu zaten `search()` ile saglaniyor (bkz. C2 plani).
 *
 * `similarity_edge` cift yonlu yazilir (`services/ingest/similarity/edges.py`
 * `_write_edges`); sorgu yalnizca `product_a` uzerinden okur ve
 * `similarity_lookup_idx (product_a, kind, score DESC)` ile cozulur. Eski
 * `product_a = X OR product_b = X` yuklemi `product_b` indeksi olmadigi icin
 * tabloyu tararken her urun sayfasinda calisiyordu.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { withStartingFrom } from "../product/get-price-comparison.ts";
import { arrayParam } from "./ranking.ts";
import type { AlternativeProduct } from "./result-types.ts";
import {
  BEST_OFFER_ORIGIN_COLUMNS,
  bestOfferCte,
  foreignPriceOf,
  type OriginColumns,
} from "./search-sql.ts";

export interface FindAlternativesOptions {
  /** Varsayilan ["visual","semantic"] - "same" ve "substitute" tohum veride bos. */
  kinds?: readonly ("same" | "visual" | "semantic" | "substitute")[];
  /** docs/pages.md: "4-6 urun". */
  limit?: number;
}

type RawRow = Record<string, unknown> &
  OriginColumns & {
    id: string;
    public_id: string;
    slug: string;
    title: string;
    primary_image_url: string | null;
    brand_name: string | null;
    current_price: string | null;
    score: number;
    kind: "same" | "visual" | "semantic" | "substitute";
  };

export async function findAlternatives(
  db: Database,
  anchorProductId: number,
  options: FindAlternativesOptions = {},
): Promise<AlternativeProduct[]> {
  const kinds = options.kinds ?? ["visual", "semantic"];
  const limit = options.limit ?? 6;

  const result = await db.execute<RawRow>(sql`
    WITH edges AS (
      SELECT DISTINCT ON (other_id) other_id, kind, score
      FROM (
        SELECT product_b AS other_id, kind, score
        FROM similarity_edge
        WHERE product_a = ${anchorProductId} AND kind = ANY(${arrayParam(kinds)}::text[])
      ) matched
      ORDER BY other_id, score DESC
    ),
    ${bestOfferCte(false, null, null, sql`o.product_id IN (SELECT other_id FROM edges)`)}
    SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
           b.name AS brand_name, bo.current_price, e.score, e.kind, ${BEST_OFFER_ORIGIN_COLUMNS}
    FROM product p
    JOIN edges e ON e.other_id = p.id
    LEFT JOIN best_offer bo ON bo.product_id = p.id
    LEFT JOIN brand b ON b.id = p.brand_id
    WHERE p.id <> ${anchorProductId} AND (p.offer_count > 0 OR p.foreign_offer_count > 0)
      AND p.publication_state = 'published'
    ORDER BY e.score DESC, p.id ASC
    LIMIT ${limit}
  `);

  const items = result.rows.map((row) => {
    const foreignPrice = foreignPriceOf(row);
    return {
      productId: Number(row.id),
      publicId: row.public_id,
      slug: row.slug,
      title: row.title,
      primaryImageUrl: row.primary_image_url,
      minPrice: row.current_price === null ? null : Number(row.current_price),
      brandName: row.brand_name,
      similarityScore: row.score,
      similarityKind: row.kind,
      ...(foreignPrice ? { foreignPrice } : {}),
      merchantName: row.merchant_name ?? null,
    };
  });
  return withStartingFrom(db, items);
}
