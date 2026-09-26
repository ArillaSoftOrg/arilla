/**
 * `findAlternatives()` — docs/pages.md, urun sayfasi "Alternatif seridi":
 * `similarity_edge`, 4-6 urun, yatay kaydirma. Sekme/siralama secimi yok -
 * ucu sekmenin tumu zaten `search()` ile saglaniyor (bkz. C2 plani).
 *
 * `similarity_edge`'in PK'i (product_a, product_b, kind); kenarin hangi
 * tarafta yazildigina guvenmeden her iki yonu de sorgular (seed cift yonlu
 * yaziyor ama bu B5'in henuz yazilmamis uretim koduna dayanacak kirilgan
 * bir varsayim olurdu).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { withStartingFrom } from "../product/get-price-comparison.ts";
import { arrayParam } from "./ranking.ts";
import type { AlternativeProduct } from "./result-types.ts";

export interface FindAlternativesOptions {
  /** Varsayilan ["visual","semantic"] - "same" ve "substitute" tohum veride bos. */
  kinds?: readonly ("same" | "visual" | "semantic" | "substitute")[];
  /** docs/pages.md: "4-6 urun". */
  limit?: number;
}

type RawRow = Record<string, unknown> & {
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
        SELECT
          (CASE WHEN product_a = ${anchorProductId} THEN product_b ELSE product_a END) AS other_id,
          kind, score
        FROM similarity_edge
        WHERE kind = ANY(${arrayParam(kinds)}::text[]) AND (product_a = ${anchorProductId} OR product_b = ${anchorProductId})
      ) matched
      ORDER BY other_id, score DESC
    ),
    best_offer AS (
      SELECT DISTINCT ON (o.product_id) o.product_id, o.current_price
      FROM offer o
      WHERE o.product_id IS NOT NULL AND o.is_active
      ORDER BY o.product_id, o.current_price ASC NULLS LAST
    )
    SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
           b.name AS brand_name, bo.current_price, e.score, e.kind
    FROM product p
    JOIN edges e ON e.other_id = p.id
    LEFT JOIN best_offer bo ON bo.product_id = p.id
    LEFT JOIN brand b ON b.id = p.brand_id
    WHERE p.id <> ${anchorProductId} AND p.offer_count > 0
    ORDER BY e.score DESC, p.id ASC
    LIMIT ${limit}
  `);

  const items = result.rows.map((row) => ({
    productId: Number(row.id),
    publicId: row.public_id,
    slug: row.slug,
    title: row.title,
    primaryImageUrl: row.primary_image_url,
    minPrice: row.current_price === null ? null : Number(row.current_price),
    brandName: row.brand_name,
    similarityScore: row.score,
    similarityKind: row.kind,
  }));
  return withStartingFrom(db, items);
}
