/**
 * Bagimsiz anlamsal aday kesfi: sorgu vektorune en yakin URUN metin vektorleri
 * (`product_text_embedding`, halfvec, kosinus), metin aramasindan BAGIMSIZ. Ardindan metin
 * aramasinin AYNI kesin suzgecleri (fiyat, marka, kategori, renk, stok, magaza), gorunurluk ve
 * baslik korumalari (aksesuar/tur/renk) uygulanir. Model cagirmaz; vektoru cagiran verir.
 *
 * Sinirlama: once en yakin komsu, sonra suzgec. Cok secici suzgec penceredeki adaylarin cogunu
 * eler; `SEMANTIC_KNN_LIMIT` bunu tolere eder. HNSW kurulana kadar en yakin komsu tam taramadir;
 * `statement_timeout` buyuyen tabloda sorguyu sinirlar (karar 0177, "Indeks").
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { visibleWithoutBestOfferSql } from "../../offers/freshness.ts";
import {
  productTitleExclusionPattern,
  productTitleRequiredPatterns,
} from "../product-title-guard.ts";
import { bestOfferCte, buildFilterClause, merchantIdsOf } from "../search-sql.ts";
import { foldedTitleExpr } from "../text-match.ts";
import type { QueryFilters } from "../types.ts";
import { requiredColorPattern } from "./accessory-guard.ts";
import {
  isValidModelVersion,
  SEMANTIC_CANDIDATE_TIMEOUT_MS,
  SEMANTIC_KNN_LIMIT,
  SEMANTIC_MAX_CANDIDATES,
} from "./config.ts";
import { requiredTypePattern } from "./product-type.ts";
import { QUERY_EMBEDDING_DIMENSIONS } from "./query-embedder.ts";

export interface SemanticCandidate {
  productId: number;
  title: string;
  similarity: number;
}

export interface SemanticCandidateRequest {
  vector: readonly number[];
  modelVersion: string;
  /** Baslik korumalari icin kullanici sorgusu. */
  text: string;
  filters: QueryFilters;
  knnLimit?: number;
  limit?: number;
  statementTimeoutMs?: number;
}

export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== QUERY_EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error("gecersiz sorgu vektoru");
  }
  return `[${vector.join(",")}]`;
}

/**
 * `model_version` ileride kismi HNSW indeksinin kosuluna sabit METIN olarak girer (parametre,
 * planlayicinin kismi indeksi secmesini engeller); bu yuzden dar bir desene karsi dogrulanir.
 */
function modelLiteral(modelVersion: string) {
  if (!isValidModelVersion(modelVersion)) throw new Error("gecersiz embedding model_version");
  return sql.raw(`'${modelVersion}'`);
}

/** Baslik korumalari: zorunlu desenler (sorgudaki tur/renk) ve aksesuar dislama. */
function titleGuards(text: string) {
  const excluded = productTitleExclusionPattern(text);
  const color = requiredColorPattern(text);
  const type = requiredTypePattern(text);
  const required = [
    ...productTitleRequiredPatterns(text),
    ...(color ? [color] : []),
    ...(type ? [type] : []),
  ];
  return [
    ...required.map((pattern) => sql`AND ${foldedTitleExpr(sql`p.title`)} ~ ${pattern}`),
    excluded
      ? sql`AND split_part(${foldedTitleExpr(sql`p.title`)}, ' with ', 1) !~ ${excluded}`
      : sql``,
  ];
}

export async function findSemanticCandidates(
  db: Database,
  request: SemanticCandidateRequest,
): Promise<SemanticCandidate[]> {
  const knnLimit = request.knnLimit ?? SEMANTIC_KNN_LIMIT;
  const limit = request.limit ?? SEMANTIC_MAX_CANDIDATES;
  const literal = vectorLiteral(request.vector);
  const model = modelLiteral(request.modelVersion);
  const inStockOnly = request.filters.in_stock_only ?? false;
  const timeout = request.statementTimeoutMs ?? SEMANTIC_CANDIDATE_TIMEOUT_MS;

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeout)}, true)`);
    // HNSW kuruldugunda: ef_search >= knnLimit olmali, yoksa indeks daha az satir doner.
    await tx.execute(
      sql`SELECT set_config('hnsw.ef_search', ${String(Math.min(1000, Math.max(40, knnLimit)))}, true)`,
    );
    return tx.execute<{ id: string; title: string; similarity: number }>(sql`
      WITH knn AS MATERIALIZED (
        SELECT e.product_id,
               (1 - (e.embedding <=> ${literal}::halfvec(768)))::double precision AS similarity
        FROM product_text_embedding e
        WHERE e.model_version = ${model}
        ORDER BY e.embedding <=> ${literal}::halfvec(768)
        LIMIT ${knnLimit}
      ),
      ${bestOfferCte(inStockOnly, merchantIdsOf(request.filters), null, sql`o.product_id IN (SELECT product_id FROM knn)`)}
      SELECT p.id::text AS id, p.title, k.similarity
      FROM knn k
      JOIN product p ON p.id = k.product_id
      JOIN best_offer bo ON bo.product_id = p.id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      WHERE p.publication_state = 'published'
        AND ${visibleWithoutBestOfferSql("p", "bo")}
        AND ${buildFilterClause(request.filters)}
        ${sql.join(titleGuards(request.text), sql` `)}
      ORDER BY k.similarity DESC, p.id ASC
      LIMIT ${limit}
    `);
  });

  return rows.rows.map((row) => ({
    productId: Number(row.id),
    title: row.title,
    similarity: Number(row.similarity),
  }));
}

/** Verilen urunlerin sorgu vektorune kosinus benzerligi (yalniz vektoru olanlar doner). */
export async function similaritiesFor(
  db: Database,
  request: { vector: readonly number[]; modelVersion: string; productIds: readonly number[] },
): Promise<Map<number, number>> {
  if (request.productIds.length === 0) return new Map();
  const literal = vectorLiteral(request.vector);
  const rows = await db.execute<{ id: string; similarity: number }>(sql`
    SELECT e.product_id::text AS id,
           (1 - (e.embedding <=> ${literal}::halfvec(768)))::double precision AS similarity
    FROM product_text_embedding e
    WHERE e.model_version = ${modelLiteral(request.modelVersion)}
      AND e.product_id = ANY(${sql.param([...request.productIds])}::bigint[])
  `);
  return new Map(rows.rows.map((row) => [Number(row.id), Number(row.similarity)]));
}
