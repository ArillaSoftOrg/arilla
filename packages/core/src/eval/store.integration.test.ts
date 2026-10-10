/**
 * Karar 0096: degerlendirme / hata veri seti — gercek (yalitilmis) Postgres.
 * Testler yalnizca kendi `t96_` islemlerini ve kendi vakalarini siler.
 */
import type { Database } from "@arilla/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmError } from "../llm/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  aiErrorBreakdown,
  caseKey,
  latestEvalRun,
  purgeAiErrorEvents,
  recordAiError,
  recordDatasetSnapshot,
  recordEvalRun,
} from "./store.ts";

const SUFFIX = Date.now().toString(36).slice(-6);
const OP = `t96_op_${SUFFIX}`;
const VERSION = `t96-${SUFFIX}`;

/** Yalnizca bu testin yazdigi satirlari ayirt eder. */
const items = { suffix: SUFFIX, cases: ["a", "b"] };

async function ownerQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return withOwnerClient(async (c) => (await c.query<T>(text, params)).rows);
}

async function expectDenied(statement: string, params: unknown[] = []) {
  // arilla_app baglantisi: yetki hatasi (42501) beklenir.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await expect(client.query(statement, params)).rejects.toMatchObject({ code: "42501" });
  } finally {
    await client.end();
  }
}

describe("ai_eval — entegrasyon", () => {
  let db: Database;
  let snapshotId: number;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await ownerQuery("DELETE FROM ai_error_event WHERE operation = $1", [OP]);
    await ownerQuery(
      "DELETE FROM ai_eval_run WHERE snapshot_id IN (SELECT id FROM dataset_snapshot WHERE version = $1)",
      [VERSION],
    );
    await ownerQuery("DELETE FROM dataset_snapshot WHERE version = $1", [VERSION]);
  });

  it("ayni icerikli snapshot ikinci kez satir uretmez", async () => {
    snapshotId = await recordDatasetSnapshot(db, {
      dataset: "intent",
      version: VERSION,
      items,
      verifiedCount: 2,
    });
    const again = await recordDatasetSnapshot(db, {
      dataset: "intent",
      version: VERSION,
      items,
      verifiedCount: 2,
    });
    expect(again).toBe(snapshotId);
    const rows = await ownerQuery("SELECT 1 FROM dataset_snapshot WHERE version = $1", [VERSION]);
    expect(rows).toHaveLength(1);
  });

  it("kosu ve vakalar tek islemde yazilir; en son kosu okunur", async () => {
    const runId = await recordEvalRun(db, {
      snapshotId,
      component: "gemini_intent",
      algorithmVersion: "rules-v1",
      metrics: { macroF1: 0.9, exactPassRate: 1 },
      cases: [
        { caseKey: caseKey("intent", `ok-${SUFFIX}`), outcome: "pass" },
        {
          caseKey: caseKey("intent", `bad-${SUFFIX}`),
          outcome: "fail",
          failureClass: "wrong_action",
          score: 0.2,
        },
      ],
    });
    const latest = await latestEvalRun(db, "gemini_intent", snapshotId);
    expect(latest?.id).toBe(runId);
    expect(latest?.metrics).toEqual({ macroF1: 0.9, exactPassRate: 1 });
    const cases = await ownerQuery("SELECT outcome FROM ai_eval_case WHERE run_id = $1", [runId]);
    expect(cases).toHaveLength(2);
  });

  it("kosu atomiktir: gecersiz vaka tum kosuyu geri alir", async () => {
    await expect(
      recordEvalRun(db, {
        snapshotId,
        component: "matching",
        algorithmVersion: "rollback-test",
        metrics: {},
        cases: [{ caseKey: "ham metin olmaz", outcome: "pass" }],
      }),
    ).rejects.toThrow();
    const rows = await ownerQuery(
      "SELECT 1 FROM ai_eval_run WHERE algorithm_version = 'rollback-test'",
    );
    expect(rows).toHaveLength(0);
  });

  it("cevrimdisi kosu maliyet/cagri yazamaz", async () => {
    await expect(
      recordEvalRun(db, {
        snapshotId,
        component: "search",
        algorithmVersion: "offline-cost",
        metrics: {},
        costMicros: 5,
        cases: [],
      }),
    ).rejects.toThrow();
  });

  it("hata olayi yazilir, sinif ve ozet maskelenir; asla firlatmaz", async () => {
    const ok = await recordAiError(db, {
      provider: "gemini",
      operation: OP,
      surface: "eval",
      error: new LlmError("rate_limited", 429),
      latencyMs: 120.4,
    });
    expect(ok).toBe(true);
    await recordAiError(db, {
      provider: "jina",
      operation: OP,
      surface: "eval",
      error: new Error("failed token=ABC123 for user@example.com"),
    });
    const rows = await ownerQuery<{
      error_class: string;
      error_summary: string;
      latency_ms: number | null;
    }>(
      "SELECT error_class, error_summary, latency_ms FROM ai_error_event WHERE operation = $1 ORDER BY id",
      [OP],
    );
    expect(rows[0]).toMatchObject({ error_class: "rate_limited", latency_ms: 120 });
    expect(rows[1]?.error_summary).not.toContain("ABC123");
    expect(rows[1]?.error_summary).not.toContain("user@example.com");
    // gecersiz operasyon adi: CHECK reddeder ama istisna disari cikmaz
    expect(
      await recordAiError(db, {
        provider: "other",
        operation: "Gecersiz Ad",
        surface: "eval",
        error: "x",
      }),
    ).toBe(false);
  });

  it("dagilim saglayici x sinif gruplar", async () => {
    const rows = await aiErrorBreakdown(db, 1);
    expect(rows.some((r) => r.provider === "gemini" && r.errorClass === "rate_limited")).toBe(true);
  });

  it("append-only: arilla_app degerlendirme satirini guncelleyemez/silemez", async () => {
    await expectDenied("UPDATE ai_eval_run SET regressed = TRUE WHERE snapshot_id = $1", [
      snapshotId,
    ]);
    await expectDenied("DELETE FROM ai_eval_run WHERE snapshot_id = $1", [snapshotId]);
    await expectDenied("UPDATE dataset_snapshot SET verified_count = 0 WHERE id = $1", [
      snapshotId,
    ]);
    await expectDenied("UPDATE ai_error_event SET error_class = 'unknown' WHERE operation = $1", [
      OP,
    ]);
  });

  it("saklama temizligi yalnizca 180 gunden eskiyi siler", async () => {
    await ownerQuery(
      `INSERT INTO ai_error_event (occurred_at, provider, operation, surface, error_class)
       VALUES (now() - interval '200 days', 'gemini', $1, 'eval', 'timeout')`,
      [OP],
    );
    const deleted = await purgeAiErrorEvents(db);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await ownerQuery(
      "SELECT count(*)::int AS n FROM ai_error_event WHERE operation = $1",
      [OP],
    );
    expect(remaining[0]?.n).toBe(2);
  });
});
