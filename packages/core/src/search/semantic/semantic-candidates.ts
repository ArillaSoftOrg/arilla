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
import { type SQL, sql } from "drizzle-orm";
import { visibleWithoutBestOfferSql } from "../../offers/freshness.ts";
import {
  productTitleExclusionPattern,
  productTitleRequiredPatterns,
} from "../product-title-guard.ts";
import { bestOfferCte, buildFilterClause, merchantIdsOf } from "../search-sql.ts";
import { foldedTitleExpr } from "../text-match.ts";
import type { QueryFilters } from "../types.ts";
import { requiredColorPattern } from "./accessory-guard.ts";
import { DEFAULT_SEMANTIC_INDEX, type SemanticIndex } from "./active-index.ts";
import {
  isValidModelVersion,
  SEMANTIC_CANDIDATE_TIMEOUT_MS,
  SEMANTIC_KNN_LIMIT,
  SEMANTIC_MAX_CANDIDATES,
} from "./config.ts";
import { requiredTypePattern } from "./product-type.ts";
import { isSafeCategoryLiteral } from "./strategy.ts";

export interface SemanticCandidate {
  productId: number;
  title: string;
  similarity: number;
}

export interface SemanticCandidateRequest {
  vector: readonly number[];
  modelVersion: string;
  /** Okunacak tablo ve boyut (karar 0181); verilmezse varsayilan uretim indeksi. */
  index?: SemanticIndex;
  /** Baslik korumalari icin kullanici sorgusu. */
  text: string;
  filters: QueryFilters;
  knnLimit?: number;
  limit?: number;
  statementTimeoutMs?: number;
  /** HNSW `ef_search` alt siniri (karar 0189 secicisi); en az `knnLimit` uygulanir. */
  efSearch?: number;
}

export function vectorLiteral(
  vector: readonly number[],
  dimensions: number = DEFAULT_SEMANTIC_INDEX.dimensions,
): string {
  if (vector.length !== dimensions || !vector.every(Number.isFinite)) {
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

/**
 * Tablo ve `halfvec(n)` tipi yalniz beyaz listedeki indeksten gelir. Baska modelin vektoru hicbir
 * zaman karsilastirilmaz: sorgu `model_version` ile suzulur, boyut `vectorLiteral`'da denetlenir.
 */
function indexSql(index: SemanticIndex) {
  if (!["product_text_embedding", "product_text_embedding_d384"].includes(index.table)) {
    throw new Error("gecersiz embedding tablosu");
  }
  if (!Number.isInteger(index.dimensions) || index.dimensions < 1 || index.dimensions > 4000) {
    throw new Error("gecersiz embedding boyutu");
  }
  return { table: sql.raw(index.table), type: sql.raw(`halfvec(${index.dimensions})`) };
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

/** KNN CTE'sinden sonra: en iyi teklif, gorunurluk, metin aramasinin AYNI kesin suzgecleri. */
function candidateTail(request: SemanticCandidateRequest, limit: number): SQL {
  const inStockOnly = request.filters.in_stock_only ?? false;
  return sql`
      ${bestOfferCte(inStockOnly, merchantIdsOf(request.filters), null, sql`o.product_id IN (SELECT product_id FROM knn)`)}
      SELECT p.id::text AS id, p.title, k.similarity, k.pool_n
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
      LIMIT ${limit}`;
}

/**
 * Global KNN (sabit sablon): `model_version` SABIT metin, boylece ayni kosullu kismi HNSW
 * (`WHERE model_version = '<model>'`) genel planda da secilebilir. HNSW yoksa tam taramadir:
 * sunum (karar 0190) bu sablonu yalniz envanterde HAZIR HNSW varken calistirir.
 */
export function globalKnnSql(request: SemanticCandidateRequest): SQL {
  const knnLimit = request.knnLimit ?? SEMANTIC_KNN_LIMIT;
  const limit = request.limit ?? SEMANTIC_MAX_CANDIDATES;
  const index = request.index ?? DEFAULT_SEMANTIC_INDEX;
  const { table, type } = indexSql(index);
  const literal = vectorLiteral(request.vector, index.dimensions);
  const model = modelLiteral(request.modelVersion);
  return sql`
      WITH knn AS MATERIALIZED (
        SELECT e.product_id,
               (1 - (e.embedding <=> ${literal}::${type}))::double precision AS similarity,
               NULL::bigint AS pool_n
        FROM ${table} e
        WHERE e.model_version = ${model}
        ORDER BY e.embedding <=> ${literal}::${type}
        LIMIT ${knnLimit}
      ),${candidateTail(request, limit)}
    `;
}

/**
 * Kategori ici KESIN siralama (karar 0189 `exact_btree`, sabit sablon): kategori agaci B-tree
 * (`product_category_idx`) ile daraltilir, vektor PK ile okunur, en fazla `poolLimit` vektor
 * karsilastirilir. Kategori yolu PARAMETREDIR (kismi indeks yok; genel plan riski yok).
 * `pool_n > poolLimit - 1` ise havuz tasmistir: sonuc eksik olabilir, cagiran kullanmaz.
 */
export function exactCategoryKnnSql(
  request: SemanticCandidateRequest & { categoryPath: string; poolLimit: number },
): SQL {
  const knnLimit = request.knnLimit ?? SEMANTIC_KNN_LIMIT;
  const limit = request.limit ?? SEMANTIC_MAX_CANDIDATES;
  const index = request.index ?? DEFAULT_SEMANTIC_INDEX;
  const { table, type } = indexSql(index);
  const literal = vectorLiteral(request.vector, index.dimensions);
  const model = modelLiteral(request.modelVersion);
  if (!Number.isInteger(request.poolLimit) || request.poolLimit < 1 || request.poolLimit > 20_001) {
    throw new Error("gecersiz havuz siniri");
  }
  // Parametre olsa da `LIKE` joker (`%`, `_`) tasimamali: yalniz guvenli yol bicimi (karar 0190).
  if (!isSafeCategoryLiteral(request.categoryPath)) throw new Error("gecersiz kategori yolu");
  const path = request.categoryPath;
  return sql`
      WITH pool AS MATERIALIZED (
        SELECT e.product_id, e.embedding
        FROM product p
        JOIN ${table} e ON e.product_id = p.id AND e.model_version = ${model}
        WHERE p.category_id IN (
                SELECT id FROM category WHERE path = ${path} OR path LIKE ${path} || '/%')
          AND p.publication_state = 'published'
        LIMIT ${request.poolLimit}
      ),
      knn AS MATERIALIZED (
        SELECT product_id,
               (1 - (embedding <=> ${literal}::${type}))::double precision AS similarity,
               (SELECT count(*) FROM pool)::bigint AS pool_n
        FROM pool
        ORDER BY embedding <=> ${literal}::${type}
        LIMIT ${knnLimit}
      ),${candidateTail(request, limit)}
    `;
}

type CandidateRow = { id: string; title: string; similarity: number; pool_n: string | null };

function toCandidates(rows: CandidateRow[]): SemanticCandidate[] {
  return rows.map((row) => ({
    productId: Number(row.id),
    title: row.title,
    similarity: Number(row.similarity),
  }));
}

async function runKnn(
  db: Database,
  query: SQL,
  timeout: number,
  efSearch: number | null,
): Promise<CandidateRow[]> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeout)}, true)`);
    if (efSearch !== null) {
      await tx.execute(sql`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`);
    }
    return tx.execute<CandidateRow>(query);
  });
  return rows.rows;
}

export async function findSemanticCandidates(
  db: Database,
  request: SemanticCandidateRequest,
): Promise<SemanticCandidate[]> {
  const knnLimit = request.knnLimit ?? SEMANTIC_KNN_LIMIT;
  const timeout = request.statementTimeoutMs ?? SEMANTIC_CANDIDATE_TIMEOUT_MS;
  // HNSW: ef_search >= knnLimit olmali, yoksa indeks daha az satir doner.
  const efSearch = Math.min(1000, Math.max(40, knnLimit, request.efSearch ?? 0));
  return toCandidates(await runKnn(db, globalKnnSql(request), timeout, efSearch));
}

export class SemanticPoolOverflowError extends Error {
  constructor() {
    super("semantic category pool overflow");
    this.name = "SemanticPoolOverflowError";
  }
}

/** Kategori ici kesin aday kesfi; havuz tasarsa `SemanticPoolOverflowError` (eksik sonuc verilmez). */
export async function findCategoryExactCandidates(
  db: Database,
  request: SemanticCandidateRequest & { categoryPath: string; maxRows: number },
): Promise<SemanticCandidate[]> {
  const timeout = request.statementTimeoutMs ?? SEMANTIC_CANDIDATE_TIMEOUT_MS;
  const poolLimit = request.maxRows + 1;
  const rows = await runKnn(db, exactCategoryKnnSql({ ...request, poolLimit }), timeout, null);
  if (rows.some((row) => Number(row.pool_n ?? 0) >= poolLimit)) {
    throw new SemanticPoolOverflowError();
  }
  return toCandidates(rows);
}

/** Verilen urunlerin sorgu vektorune kosinus benzerligi (yalniz vektoru olanlar doner). */
export async function similaritiesFor(
  db: Database,
  request: {
    vector: readonly number[];
    modelVersion: string;
    productIds: readonly number[];
    index?: SemanticIndex;
  },
): Promise<Map<number, number>> {
  if (request.productIds.length === 0) return new Map();
  const index = request.index ?? DEFAULT_SEMANTIC_INDEX;
  const { table, type } = indexSql(index);
  const literal = vectorLiteral(request.vector, index.dimensions);
  const rows = await db.execute<{ id: string; similarity: number }>(sql`
    SELECT e.product_id::text AS id,
           (1 - (e.embedding <=> ${literal}::${type}))::double precision AS similarity
    FROM ${table} e
    WHERE e.model_version = ${modelLiteral(request.modelVersion)}
      AND e.product_id = ANY(${sql.param([...request.productIds])}::bigint[])
  `);
  return new Map(rows.rows.map((row) => [Number(row.id), Number(row.similarity)]));
}
