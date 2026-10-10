/**
 * Karar 0098: degerlendirme kaydi - gercek (yalitilmis) Postgres. Yalnizca
 * kendi `t98-` surumlerini yazar ve siler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAiQualityOverview } from "../admin/ai-quality.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { runIntentEval } from "./intent-eval.ts";
import { recordEvaluation } from "./record.ts";
import { intentRecord } from "./record-adapters.ts";

const SUFFIX = Date.now().toString(36).slice(-6);
const V1 = `t98-1-${SUFFIX}`;
const V2 = `t98-2-${SUFFIX}`;
const admin = { userId: 1, role: "admin" as const };

async function owner<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return withOwnerClient(async (c) => (await c.query<T>(text, params)).rows);
}

describe("recordEvaluation - entegrasyon", () => {
  let db: Database;
  const { rows, summary } = runIntentEval();

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await owner("DELETE FROM ai_eval_run WHERE algorithm_version LIKE $1", [`t98-%${SUFFIX}`]);
    await owner("DELETE FROM dataset_snapshot WHERE version LIKE 't98-%' AND code_ref IS NULL");
  });

  // Gercek altin set icerigi baska kosularla paylasilir; testin kendi veri
  // setini kullaniriz ki sayimlar yalniz bu teste ait olsun.
  const own = (
    version: string,
    items: unknown,
    algorithm: string,
    metrics: Record<string, number>,
  ) => ({
    ...intentRecord(rows, summary, algorithm),
    snapshot: { dataset: "intent" as const, version, items, verifiedCount: 3 },
    metrics,
  });
  const itemsA = { suffix: SUFFIX, set: "A" };
  const itemsB = { suffix: SUFFIX, set: "B" };
  const good = { accuracy: 0.9, macro_f1: 0.9, exact_pass_rate: 0.9 };
  const bad = { accuracy: 0.7, macro_f1: 0.8, exact_pass_rate: 0.9 };

  it("ilk kayit: temel cizgi ve regresyon yok", async () => {
    const r = await recordEvaluation(db, own(`t98-set-a-${SUFFIX}`, itemsA, V1, good));
    expect(r.duplicate).toBe(false);
    expect(r.baselineRunId).toBeNull();
    expect(r.regressed).toBeNull();
    const cases = await owner("SELECT case_key FROM ai_eval_case WHERE run_id = $1", [r.runId]);
    expect(cases.length).toBe(rows.length);
  });

  it("ayni kosu tekrar kaydedilmez (idempotent), eszamanli da", async () => {
    const before = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_eval_run WHERE algorithm_version = $1",
      [V1],
    );
    const results = await Promise.all([
      recordEvaluation(db, own(`t98-set-a-${SUFFIX}`, itemsA, V1, good)),
      recordEvaluation(db, own(`t98-set-a-${SUFFIX}`, itemsA, V1, good)),
    ]);
    expect(results.every((r) => r.duplicate)).toBe(true);
    const after = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_eval_run WHERE algorithm_version = $1",
      [V1],
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("ayni veri setinde kotulesme regresyon olarak kaydedilir ve baglanir", async () => {
    const r = await recordEvaluation(db, own(`t98-set-a-${SUFFIX}`, itemsA, V2, bad));
    expect(r.duplicate).toBe(false);
    expect(r.baselineRunId).not.toBeNull();
    expect(r.regressed).toBe(true);
    expect(r.regressedMetrics).toContain("accuracy");
    const [row] = await owner<{ regressed: boolean; baseline_run_id: number }>(
      "SELECT regressed, baseline_run_id FROM ai_eval_run WHERE id = $1",
      [r.runId],
    );
    expect(row?.regressed).toBe(true);
  });

  it("veri seti degistiyse karsilastirma YAPILMAZ ve yeni snapshot olusur", async () => {
    const r = await recordEvaluation(
      db,
      own(`t98-set-b-${SUFFIX}`, itemsB, `t98-3-${SUFFIX}`, {
        accuracy: 0.1,
        macro_f1: 0.1,
        exact_pass_rate: 0.1,
      }),
    );
    expect(r.baselineRunId).toBeNull();
    expect(r.regressed).toBeNull();
    expect(r.baselineStatus).toBe("dataset_changed");
    const snaps = await owner("SELECT 1 FROM dataset_snapshot WHERE version IN ($1, $2)", [
      `t98-set-a-${SUFFIX}`,
      `t98-set-b-${SUFFIX}`,
    ]);
    expect(snaps).toHaveLength(2);
  });

  it("eszamanli ilk kayit: 6 paralel cagri tek satir yazar", async () => {
    const input = own(`t98-set-a-${SUFFIX}`, itemsA, `t98-par-${SUFFIX}`, good);
    const results = await Promise.all(Array.from({ length: 6 }, () => recordEvaluation(db, input)));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);
  });

  it("ayni metrik ama farkli vaka sonucu ayni kosu sayilmaz", async () => {
    const algo = `t98-cases-${SUFFIX}`;
    const base = own(`t98-set-a-${SUFFIX}`, itemsA, algo, good);
    const first = await recordEvaluation(db, base);
    const flipped = {
      ...base,
      cases: base.cases.map((c, i) =>
        i === 0 ? { ...c, outcome: "fail" as const, failureClass: "wrong_action" } : c,
      ),
    };
    const second = await recordEvaluation(db, flipped);
    expect(second.duplicate).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect((await recordEvaluation(db, flipped)).duplicate).toBe(true);
  });

  it("yonetim paneli kayitli sonucu okur (surum, metrik, regresyon)", async () => {
    const overview = await getAiQualityOverview(db, admin, { days: 30 });
    const run = overview.history.find((h) => h.algorithmVersion === V2);
    expect(run?.datasetVersion).toBe(`t98-set-a-${SUFFIX}`);
    expect(run?.regressedFlag).toBe(true);
    expect(run?.metrics.accuracy).toBe(0.7);
    expect(run?.live).toBe(false);
  });
});
