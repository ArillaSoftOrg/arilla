/**
 * IntentV2 arama olcumu, kosul (a) deterministik ve (b) oracle niyet
 * (docs/decisions/0171 §10). Yalnizca yerel veritabani (betik denetler).
 *
 * Iki kosul AYNI ayristirmayi (`resolveQuery`) ve AYNI kademeli yolu
 * (`searchWithFallback`) kullanir; (b) yalnizca altin etiketin planini
 * `applyIntentPlan` ile ekler. Boylece fark yalnizca niyetten gelir.
 */
import type { Database } from "@arilla/db";
import type { IntentV2Case } from "../../eval/intent-v2-eval.ts";
import {
  type IntentSearchRow,
  measureItems,
  overlap,
  planFromGold,
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

export async function evaluateIntentSearch(
  db: Database,
  cases: readonly IntentV2Case[],
  merchantIds: number[],
): Promise<IntentSearchRow[]> {
  const rows: IntentSearchRow[] = [];
  for (const testCase of cases) {
    const { parsed } = await resolveQuery(db, testCase.q);
    const plan = planFromGold(testCase.gold);
    const oracle = applyIntentPlan(parsed, plan);
    const a = await runPipeline(db, parsed, merchantIds);
    const planApplied = JSON.stringify(oracle.filters) !== JSON.stringify(parsed.filters);
    const b = planApplied ? await runPipeline(db, oracle, merchantIds) : a;
    const ma = measureItems(testCase, a.items, a.stage);
    const mb = measureItems(testCase, b.items, b.stage);
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
