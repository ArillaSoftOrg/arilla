/**
 * Faz 1A-4 / karar 0098: degerlendirme kaydi - yalitilmis yerel Postgres.
 * Yalnizca kendi sentetik veri setini (`t98` ekli) yazar ve siler; gercek
 * golden/arama setlerinin snapshot'larina dokunmaz.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAiQualityOverview } from "../admin/ai-quality.ts";
import type { AdminActor } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { recordEvalResult } from "./record.ts";
import { caseKey, type EvalCaseInput } from "./store.ts";

const SUFFIX = Date.now().toString(36).slice(-6);
const ALGO = (n: number) => `t98-${n}-${SUFFIX}`;
const admin: AdminActor = { userId: 1, role: "admin" };
let db: Database;

const cases = (failFirst: boolean): EvalCaseInput[] => [
  failFirst
    ? { caseKey: caseKey("intent", `x-${SUFFIX}-1`), outcome: "fail", failureClass: "wrong_action" }
    : { caseKey: caseKey("intent", `x-${SUFFIX}-1`), outcome: "pass" },
  { caseKey: caseKey("intent", `x-${SUFFIX}-2`), outcome: "pass" },
];
const input = (items: unknown, algo: number, accuracy: number, failFirst = false) => ({
  component: "gemini_intent" as const,
  dataset: "intent" as const,
  datasetVersion: `t98-${SUFFIX}`,
  items,
  verifiedCount: 2,
  algorithmVersion: ALGO(algo),
  metrics: { accuracy, macro_f1: accuracy, exact_pass_rate: accuracy },
  cases: cases(failFirst),
});

const count = (sql: string, params: unknown[]) =>
  withOwnerClient(async (c) => Number((await c.query(sql, params)).rows[0].n));

beforeAll(() => {
  db = getTestDb();
});

afterAll(async () => {
  await withOwnerClient(async (c) => {
    await c.query("DELETE FROM ai_eval_run WHERE algorithm_version LIKE $1", [`t98-%-${SUFFIX}`]);
    await c.query("DELETE FROM dataset_snapshot WHERE version = $1", [`t98-${SUFFIX}`]);
  });
});

describe("recordEvalResult", () => {
  const itemsA = { suffix: SUFFIX, v: "A" };
  const itemsB = { suffix: SUFFIX, v: "B" };

  it("links run, snapshot version, algorithm version and cases; offline run is free", async () => {
    const out = await recordEvalResult(db, input(itemsA, 1, 0.9));
    expect(out.reused).toBe(false);
    const rows = await withOwnerClient(
      async (c) =>
        (
          await c.query(
            `SELECT r.algorithm_version, r.live, r.api_calls, s.version, s.verified_count,
                    (SELECT count(*)::int FROM ai_eval_case WHERE run_id = r.id) AS cases
               FROM ai_eval_run r JOIN dataset_snapshot s ON s.id = r.snapshot_id WHERE r.id = $1`,
            [out.runId],
          )
        ).rows,
    );
    expect(rows[0]).toMatchObject({
      algorithm_version: ALGO(1),
      live: false,
      api_calls: 0,
      version: `t98-${SUFFIX}`,
      verified_count: 2,
      cases: 2,
    });
  });

  it("is idempotent: the same run is not written twice (even concurrently)", async () => {
    const again = await recordEvalResult(db, input(itemsA, 1, 0.9));
    expect(again.reused).toBe(true);
    const parallel = await Promise.all(
      Array.from({ length: 4 }, () => recordEvalResult(db, input(itemsA, 3, 0.9))),
    );
    expect(new Set(parallel.map((p) => p.runId)).size).toBe(1);
    expect(parallel.filter((p) => !p.reused)).toHaveLength(1);
    expect(
      await count("SELECT count(*) AS n FROM ai_eval_run WHERE algorithm_version = $1", [ALGO(3)]),
    ).toBe(1);
  });

  it("compares with the previous run on the same dataset and flags a regression", async () => {
    const worse = await recordEvalResult(db, input(itemsA, 2, 0.7, true));
    expect(worse.baselineStatus).toBe("compared");
    expect(worse.baselineRunId).not.toBeNull();
    expect(worse.regressed).toBe(true);
    expect(worse.changes.find((c) => c.metric === "accuracy")?.regressed).toBe(true);
  });

  it("does not compare when the dataset content changed", async () => {
    const out = await recordEvalResult(db, input(itemsB, 1, 0.5));
    expect(out.baselineStatus).toBe("dataset_changed");
    expect(out.baselineRunId).toBeNull();
    expect(out.regressed).toBeNull();
    expect(out.changes).toEqual([]);
  });

  it("the admin reader sees the recorded run, its dataset version and no raw case keys", async () => {
    await recordEvalResult(db, input(itemsB, 4, 0.6, true));
    const overview = await getAiQualityOverview(db, admin, { days: 30 });
    const intent = overview.components.find((c) => c.component === "gemini_intent");
    expect(intent?.latest?.algorithmVersion).toBe(ALGO(4));
    expect(intent?.latest?.datasetVersion).toBe(`t98-${SUFFIX}`);
    expect(intent?.comparability).toBe("comparable");
    expect(intent?.failureClasses).toContainEqual({ failureClass: "wrong_action", count: 1 });
    expect(JSON.stringify(overview)).not.toContain(caseKey("intent", `x-${SUFFIX}-1`));
  });
});
