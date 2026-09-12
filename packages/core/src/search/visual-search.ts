/**
 * `/ara/gorsel` — yüklenen görselin embedding'ine en yakın katalog
 * tekliflerini bulur. `find-alternatives.ts` ile aynı ham `sql` deseni:
 * Drizzle'ın pgvector için `<=>` operatör yardımcısı yok.
 *
 * `embedding.model_version` eşitliği aranır: sahte istemci (geliştirme) ve
 * gerçek istemci (üretim) farklı vektör uzayları üretir, ikisini
 * karşılaştırmak anlamsız kosinüs mesafeleri verir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

export interface VisualSearchItem {
  productId: number;
  publicId: string;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
  similarityScore: number;
}

export interface VisualSearchOptions {
  limit?: number;
}

type RawRow = Record<string, unknown> & {
  id: string;
  public_id: string;
  slug: string;
  title: string;
  primary_image_url: string | null;
  current_price: string | null;
  offer_count: number;
  similarity: number;
};

/** pgvector metin girdi biçimi: `'[0.1,0.2,...]'::vector`. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export async function searchByImageVector(
  db: Database,
  vector: readonly number[],
  modelVersion: string,
  options: VisualSearchOptions = {},
): Promise<VisualSearchItem[]> {
  const limit = options.limit ?? 24;
  // Aynı urunun birden fazla offer'i olabilir; urun basina tekillestirmeden
  // once daha genis bir aday havuzu cekiyoruz.
  const candidateLimit = limit * 8;
  const vectorLiteral = toVectorLiteral(vector);

  const result = await db.execute<RawRow>(sql`
    WITH nearest AS (
      SELECT e.target_id AS offer_id, 1 - (e.vector <=> ${vectorLiteral}::vector) AS similarity
      FROM embedding e
      WHERE e.target_type = 'offer' AND e.kind = 'image' AND e.model_version = ${modelVersion}
      ORDER BY e.vector <=> ${vectorLiteral}::vector
      LIMIT ${candidateLimit}
    ),
    by_product AS (
      SELECT DISTINCT ON (o.product_id) o.product_id, n.similarity
      FROM nearest n
      JOIN offer o ON o.id = n.offer_id
      WHERE o.product_id IS NOT NULL
      ORDER BY o.product_id, n.similarity DESC
    ),
    best_offer AS (
      SELECT DISTINCT ON (o.product_id) o.product_id, o.current_price
      FROM offer o
      WHERE o.product_id IS NOT NULL AND o.is_active
      ORDER BY o.product_id, o.current_price ASC NULLS LAST
    )
    SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
           bo.current_price, p.offer_count, bp.similarity
    FROM by_product bp
    JOIN product p ON p.id = bp.product_id
    LEFT JOIN best_offer bo ON bo.product_id = p.id
    WHERE p.offer_count > 0
    ORDER BY bp.similarity DESC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    productId: Number(row.id),
    publicId: row.public_id,
    slug: row.slug,
    title: row.title,
    primaryImageUrl: row.primary_image_url,
    minPrice: row.current_price === null ? null : Number(row.current_price),
    offerCount: Number(row.offer_count),
    similarityScore: row.similarity,
  }));
}
