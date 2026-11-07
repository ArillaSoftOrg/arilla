/**
 * IntentV2 arama olcumu, kosul (a) deterministik ve (b) oracle niyet
 * (docs/decisions/0171 §10). Yalnizca yerel veritabani (betik denetler).
 *
 * Iki kosul AYNI ayristirmayi (`resolveQuery`) ve AYNI kademeli yolu
 * (`searchWithFallback`) kullanir; (b) yalnizca altin etiketin planini
 * `applyIntentPlan` ile ekler. Boylece fark yalnizca niyetten gelir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import type { IntentV2Case } from "../../eval/intent-v2-eval.ts";
import {
  classifyZero,
  type GoldPlanOptions,
  type IntentSearchRow,
  measureItems,
  overlap,
  planFromGold,
  typeProbeTerms,
  type ZeroCause,
} from "../../eval/intent-v2-search.ts";
import { applyIntentPlan } from "../../intent/to-search.ts";
import {
  createPostgresSearchProvider,
  createSeedAliasSource,
  searchWithFallback,
} from "../fallback/index.ts";
import { resolveQuery } from "../query-resolution.ts";
import type { QueryObject } from "../types.ts";

const TIME_BUDGET_MS = 60_000;

async function runPipeline(db: Database, parsed: QueryObject, merchantIds: number[]) {
  const scoped = { ...parsed, filters: { ...parsed.filters, merchant_ids: merchantIds } };
  const outcome = await searchWithFallback(
    createPostgresSearchProvider(db),
    { parsed: scoped, sort: scoped.sort, page: 1, pageSize: 24 },
    { aliases: createSeedAliasSource(), timeBudgetMs: TIME_BUDGET_MS },
  );
  return {
    items: outcome.items,
    stage: outcome.mode === "empty" ? "empty" : outcome.trace.stage,
  };
}

/**
 * Kapsamdaki katalogda basligi urun turunun TUM terimlerini kelime basinda
 * iceren urun var mi; varsa en fazla 3 ornek baslik doner (kural tabanli;
 * alakalilik kaniti degil, insan dogrulamasi icin). Yalniz etiketteki tur adi
 * kullanilir; eslesen urun ilgili aksesuar olabilir ("laptop" -> laptop cantasi).
 */
async function catalogProbe(
  db: Database,
  testCase: IntentV2Case,
  merchantIds: number[],
): Promise<string[]> {
  const candidates = [testCase.gold.type ?? ""];
  for (const candidate of candidates) {
    const terms = typeProbeTerms(candidate);
    if (terms.length === 0) continue;
    const conditions = sql.join(
      terms.map((term) => {
        const pattern = `\\m${term.prefix}${term.whole ? "\\M" : ""}`;
        return sql`translate(lower(p.title), 'çğıöşüâîû', 'cgiosuaiu') ~ ${pattern}`;
      }),
      sql` AND `,
    );
    const result = await db.execute<{ title: string }>(sql`
      SELECT p.title FROM product p
       WHERE EXISTS (SELECT 1 FROM offer o WHERE o.product_id = p.id AND o.is_active
                       AND o.merchant_id = ANY(${sql.param(merchantIds)}::bigint[]))
         AND ${conditions}
       ORDER BY p.id
       LIMIT 3`);
    if (result.rows.length > 0) return result.rows.map((row) => row.title);
  }
  return [];
}

const hasFilters = (q: QueryObject) =>
  Object.values(q.filters).some(
    (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0),
  );

export async function evaluateIntentSearch(
  db: Database,
  cases: readonly IntentV2Case[],
  merchantIds: number[],
  options: GoldPlanOptions = {},
): Promise<IntentSearchRow[]> {
  const rows: IntentSearchRow[] = [];
  for (const testCase of cases) {
    const { parsed } = await resolveQuery(db, testCase.q);
    const plan = planFromGold(testCase.gold, options);
    const oracle = applyIntentPlan(parsed, plan);
    const a = await runPipeline(db, parsed, merchantIds);
    const planApplied = JSON.stringify(oracle.filters) !== JSON.stringify(parsed.filters);
    const b = planApplied ? await runPipeline(db, oracle, merchantIds) : a;
    let probeTitles: string[] = [];
    let causeA: ZeroCause | null = null;
    let causeB: ZeroCause | null = null;
    if (a.items.length === 0 || b.items.length === 0) {
      probeTitles = await catalogProbe(db, testCase, merchantIds);
      const has = probeTitles.length > 0;
      const unfiltered = await runPipeline(db, { ...parsed, filters: {} }, merchantIds);
      const n = unfiltered.items.length;
      causeA = classifyZero({
        catalogHasType: has,
        hadFilters: hasFilters(parsed),
        unfilteredReturned: n,
      });
      causeB = classifyZero({
        catalogHasType: has,
        hadFilters: hasFilters(oracle),
        unfilteredReturned: n,
      });
    }
    const ma = measureItems(testCase, a.items, a.stage, causeA, probeTitles);
    const mb = measureItems(testCase, b.items, b.stage, causeB, probeTitles);
    rows.push({
      id: testCase.id,
      cat: testCase.cat,
      planApplied,
      hasBudget: testCase.gold.budget !== null,
      hasExcluded:
        testCase.gold.exclude_brands.length > 0 ||
        testCase.gold.attrs.some((attr) => attr[2] === "excluded"),
      a: ma,
      b: mb,
      overlap10: overlap(ma.topIds, mb.topIds),
    });
  }
  return rows;
}
