/**
 * Metin arama regresyon olcumu (docs/decisions/0029).
 *
 * `/ara` sayfasinin yaptigini tekrarlar — `resolveQuery` + `search()`, bos
 * sonucta filtresiz 6'li geri dusus — ama kapsami bootstrap merchant'lariyla
 * sinirlar: gelistirme tohumunun sahte urunleri olcumu kirletmez.
 *
 * Yargi algoritmadan bagimsizdir (`bootstrap-queries.json`): baslik/marka
 * desenleri, veritabaninda `~*` ile uygulanir.
 *
 * Karar 0171 G6: her satir ilk 10 urun kimligini ve sonucun geldigi asamayi
 * tasir; `runEvaluation` katalog parmak izli metadata uretir. Magaza kapsami
 * (`scope`) ve arama yolu (`engine`) parametredir; varsayilanlar eski davranistir.
 */
import { createHash } from "node:crypto";
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import {
  catalogFingerprint,
  SEARCH_EVAL_FORMAT,
  type SearchEvalCatalog,
  type SearchEvalEngine,
  type SearchEvalMeta,
  type SearchEvalRun,
  type SearchEvalScope,
} from "../../eval/search-eval.ts";
import {
  createPostgresSearchProvider,
  createSeedAliasSource,
  searchWithFallback,
} from "../fallback/index.ts";
import { resolveQuery } from "../query-resolution.ts";
import { search } from "../search.ts";
import evalSet from "./bootstrap-queries.json" with { type: "json" };

export interface EvalQuery {
  group: string;
  q: string;
  all?: string[];
  brand?: string;
  absent?: boolean;
  note?: string;
}

export interface EvalRow {
  group: string;
  q: string;
  absent: boolean;
  returned: number;
  relevantAt5: number;
  relevantAt10: number;
  firstRelevant: number | null;
  /** Ilk 10 sonucun ikili ilgisi (1/0), sira korunur; P@K ve NDCG buradan hesaplanir. */
  relevance: number[];
  /** Ilk 10'daki ilgisiz sonuclar (baslik ornekleri). */
  falsePositives: string[];
  /** Katalogda kac ilgili urun var (ust sinir, recall icin). */
  relevantInCatalog: number;
  zeroResultCorrect: boolean | null;
  usedFallback: boolean;
  /** Ilk 10 sonucun urun kimlikleri, sira korunur. */
  topIds: number[];
  /**
   * Sonucun geldigi asama. `legacy`: `primary` ya da `unfiltered_fallback`;
   * `fallback`: `searchWithFallback` izinin asamasi (`exact`, `alias`, ...) ya da `empty`.
   */
  stage: string;
}

export interface EvalOptions {
  /** Varsayilan `legacy` (0029 davranisi). */
  engine?: SearchEvalEngine;
  /** Varsayilan bootstrap magazalari. */
  scope?: SearchEvalScope;
}

/** `fallback` motorunda zaman butcesi: olcum, butceyle kesilen asamaya gore degismesin. */
const EVAL_FALLBACK_TIME_BUDGET_MS = 60_000;

export const EVAL_QUERIES: readonly EvalQuery[] = evalSet.queries;

const BOOTSTRAP_MERCHANTS = sql`
  SELECT id FROM merchant WHERE feed_config->>'bootstrap_source' = 'bootstrap_shopify'
`;

export async function bootstrapMerchantIds(db: Database): Promise<number[]> {
  const result = await db.execute<{ id: string }>(BOOTSTRAP_MERCHANTS);
  return result.rows.map((row) => Number(row.id));
}

/** Kapsamin magaza kimlikleri, artan sirali. */
export async function scopeMerchantIds(db: Database, scope: SearchEvalScope): Promise<number[]> {
  let ids: number[];
  if (scope.kind === "bootstrap") {
    ids = await bootstrapMerchantIds(db);
  } else if (scope.kind === "all_active") {
    const result = await db.execute<{ id: string }>(sql`SELECT id FROM merchant WHERE is_active`);
    ids = result.rows.map((row) => Number(row.id));
  } else {
    ids = [...scope.merchantIds];
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Kapsamdaki katalogun karsilastirilabilirlik ozeti (yalnizca sayilar). */
export async function catalogSummary(
  db: Database,
  merchantIds: readonly number[],
): Promise<SearchEvalCatalog> {
  const result = await db.execute<{
    products: string;
    offers: string;
    max_product: string | null;
    max_offer: string | null;
  }>(sql`
    SELECT count(DISTINCT o.product_id)
             FILTER (WHERE p.publication_state = 'published')::text AS products,
           count(*)::text AS offers,
           max(o.product_id)::text AS max_product,
           max(o.id)::text AS max_offer
      FROM offer o
      LEFT JOIN product p ON p.id = o.product_id
     WHERE o.is_active AND o.merchant_id = ANY(${sql.param(merchantIds)}::bigint[])
  `);
  const row = result.rows[0];
  const base = {
    merchantIds: [...merchantIds],
    products: Number(row?.products ?? 0),
    activeOffers: Number(row?.offers ?? 0),
    maxProductId: row?.max_product ? Number(row.max_product) : null,
    maxOfferId: row?.max_offer ? Number(row.max_offer) : null,
  };
  return { ...base, fingerprint: catalogFingerprint(base, sha256) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function judgeClause(query: EvalQuery) {
  const titleMatch =
    query.all && query.all.length > 0
      ? sql.join(
          // Renk Shopify bolmesinde basliga yazilmayabilir (0024): urun rengi
          // de urun kimligidir, yargi onu da gorur.
          query.all.map((pattern) => sql`(p.title || ' ' || COALESCE(p.color, '')) ~* ${pattern}`),
          sql` AND `,
        )
      : sql`FALSE`;
  const brandMatch = query.brand ? sql`COALESCE(b.name, '') ~* ${query.brand}` : sql`FALSE`;
  return sql`((${titleMatch}) OR (${brandMatch}))`;
}

async function relevantIds(
  db: Database,
  query: EvalQuery,
  ids: readonly number[],
): Promise<Set<number>> {
  if (query.absent || ids.length === 0) return new Set();
  const result = await db.execute<{ id: string }>(sql`
    SELECT p.id FROM product p LEFT JOIN brand b ON b.id = p.brand_id
     WHERE p.id = ANY(${sql.param(ids)}::bigint[]) AND ${judgeClause(query)}
  `);
  return new Set(result.rows.map((row) => Number(row.id)));
}

async function relevantInCatalog(
  db: Database,
  query: EvalQuery,
  merchantIds: readonly number[],
): Promise<number> {
  if (query.absent) return 0;
  const result = await db.execute<{ n: string }>(sql`
    SELECT count(DISTINCT p.id)::text AS n
      FROM product p
      JOIN offer o ON o.product_id = p.id AND o.is_active
      LEFT JOIN brand b ON b.id = p.brand_id
     WHERE o.merchant_id = ANY(${sql.param(merchantIds)}::bigint[]) AND ${judgeClause(query)}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

interface EngineResult {
  items: { productId: number; title: string }[];
  usedFallback: boolean;
  stage: string;
}

/** 0029 yolu: `search()`; bos sonucta filtreler temizlenir (kapsam korunur), en yakin 6. */
async function runLegacy(
  db: Database,
  query: EvalQuery,
  merchantIds: number[],
): Promise<EngineResult> {
  const { parsed } = await resolveQuery(db, query.q);
  const scoped = { ...parsed, filters: { ...parsed.filters, merchant_ids: merchantIds } };
  const items = (await search(db, scoped, { limit: 24 })).items;
  if (items.length > 0) return { items, usedFallback: false, stage: "primary" };
  const fallback = {
    ...parsed,
    filters: { merchant_ids: merchantIds },
    sort: "balanced" as const,
  };
  return {
    items: (await search(db, fallback, { limit: 6 })).items,
    usedFallback: true,
    stage: "unfiltered_fallback",
  };
}

/** `/ara`'nin kademeli yolu (0066); normalizasyon (0172) uygulanmaz. */
async function runFallbackPipeline(
  db: Database,
  query: EvalQuery,
  merchantIds: number[],
): Promise<EngineResult> {
  const { parsed } = await resolveQuery(db, query.q);
  const scoped = { ...parsed, filters: { ...parsed.filters, merchant_ids: merchantIds } };
  const outcome = await searchWithFallback(
    createPostgresSearchProvider(db),
    { parsed: scoped, sort: scoped.sort, page: 1, pageSize: 24 },
    { aliases: createSeedAliasSource(), timeBudgetMs: EVAL_FALLBACK_TIME_BUDGET_MS },
  );
  return {
    items: outcome.items,
    usedFallback: outcome.mode === "fallback",
    stage: outcome.mode === "empty" ? "empty" : outcome.trace.stage,
  };
}

export async function evaluateQuery(
  db: Database,
  query: EvalQuery,
  merchantIds: number[],
  engine: SearchEvalEngine = "legacy",
): Promise<EvalRow> {
  const { items, usedFallback, stage } =
    engine === "fallback"
      ? await runFallbackPipeline(db, query, merchantIds)
      : await runLegacy(db, query, merchantIds);

  const ids = items.map((item) => item.productId);
  const inCatalog = await relevantInCatalog(db, query, merchantIds);
  const relevant = await relevantIds(db, query, ids);
  const top10 = items.slice(0, 10);
  const firstIndex = items.findIndex((item) => relevant.has(item.productId));

  return {
    group: query.group,
    q: query.q,
    absent: query.absent ?? false,
    returned: items.length,
    relevantAt5: items.slice(0, 5).filter((item) => relevant.has(item.productId)).length,
    relevantAt10: top10.filter((item) => relevant.has(item.productId)).length,
    firstRelevant: firstIndex === -1 ? null : firstIndex + 1,
    relevance: top10.map((item) => (relevant.has(item.productId) ? 1 : 0)),
    falsePositives: top10.filter((item) => !relevant.has(item.productId)).map((item) => item.title),
    relevantInCatalog: inCatalog,
    // Katalogda ilgili urun yoksa (acikca "absent" isaretli ya da yargiya
    // gore 0) dogru cevap bos sonuctur.
    zeroResultCorrect: query.absent || inCatalog === 0 ? items.length === 0 : null,
    usedFallback,
    topIds: top10.map((item) => item.productId),
    stage,
  };
}

export async function evaluateAll(db: Database, options: EvalOptions = {}): Promise<EvalRow[]> {
  return (await runEvaluation(db, options)).rows;
}

/** Satirlar + katalog parmak izli metadata (`--json` zarfi). */
export async function runEvaluation(
  db: Database,
  options: EvalOptions & { codeRef?: string } = {},
): Promise<SearchEvalRun<EvalRow>> {
  const engine = options.engine ?? "legacy";
  const scope = options.scope ?? { kind: "bootstrap" };
  const merchantIds = await scopeMerchantIds(db, scope);
  const catalog = await catalogSummary(db, merchantIds);
  const rows: EvalRow[] = [];
  for (const query of EVAL_QUERIES) {
    rows.push(await evaluateQuery(db, query, merchantIds, engine));
  }
  const meta: SearchEvalMeta = {
    format: SEARCH_EVAL_FORMAT,
    createdAt: new Date().toISOString(),
    codeRef: options.codeRef ?? "unknown",
    engine,
    scope,
    catalog,
    dataset: {
      name: "bootstrap-queries",
      queries: EVAL_QUERIES.length,
      sha256: sha256(JSON.stringify(EVAL_QUERIES)),
    },
  };
  return { meta, rows };
}
