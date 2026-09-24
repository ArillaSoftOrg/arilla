/**
 * Metin arama regresyon olcumu (docs/decisions/0029).
 *
 * `/ara` sayfasinin yaptigini tekrarlar — `resolveQuery` + `search()`, bos
 * sonucta filtresiz 6'li geri dusus — ama kapsami bootstrap merchant'lariyla
 * sinirlar: gelistirme tohumunun sahte urunleri olcumu kirletmez.
 *
 * Yargi algoritmadan bagimsizdir (`bootstrap-queries.json`): baslik/marka
 * desenleri, veritabaninda `~*` ile uygulanir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
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
  /** Ilk 10'daki ilgisiz sonuclar (baslik ornekleri). */
  falsePositives: string[];
  /** Katalogda kac ilgili urun var (ust sinir, recall icin). */
  relevantInCatalog: number;
  zeroResultCorrect: boolean | null;
  usedFallback: boolean;
}

export const EVAL_QUERIES: readonly EvalQuery[] = evalSet.queries;

const BOOTSTRAP_MERCHANTS = sql`
  SELECT id FROM merchant WHERE feed_config->>'bootstrap_source' = 'bootstrap_shopify'
`;

export async function bootstrapMerchantIds(db: Database): Promise<number[]> {
  const result = await db.execute<{ id: string }>(BOOTSTRAP_MERCHANTS);
  return result.rows.map((row) => Number(row.id));
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

export async function evaluateQuery(
  db: Database,
  query: EvalQuery,
  merchantIds: number[],
): Promise<EvalRow> {
  const { parsed } = await resolveQuery(db, query.q);
  const scoped = { ...parsed, filters: { ...parsed.filters, merchant_ids: merchantIds } };
  let items = (await search(db, scoped, { limit: 24 })).items;
  let usedFallback = false;
  if (items.length === 0) {
    // /ara ile ayni: filtreler temizlenir (kapsam korunur), en yakin 6.
    const fallback = {
      ...parsed,
      filters: { merchant_ids: merchantIds },
      sort: "balanced" as const,
    };
    items = (await search(db, fallback, { limit: 6 })).items;
    usedFallback = true;
  }

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
    falsePositives: top10.filter((item) => !relevant.has(item.productId)).map((item) => item.title),
    relevantInCatalog: inCatalog,
    // Katalogda ilgili urun yoksa (acikca "absent" isaretli ya da yargiya
    // gore 0) dogru cevap bos sonuctur.
    zeroResultCorrect: query.absent || inCatalog === 0 ? items.length === 0 : null,
    usedFallback,
  };
}

export async function evaluateAll(db: Database): Promise<EvalRow[]> {
  const merchantIds = await bootstrapMerchantIds(db);
  const rows: EvalRow[] = [];
  for (const query of EVAL_QUERIES) {
    rows.push(await evaluateQuery(db, query, merchantIds));
  }
  return rows;
}
