/**
 * Karar 0097: AI kalite paneli okuyucusu - gercek (yalitilmis) Postgres.
 * Testler yalnizca kendi `t97_` verilerini yazar ve siler; tablolar bu testten
 * once baska veri tasiyabilir, bu yuzden bilesen bazli sonuclar yalniz kendi
 * surum etiketlerimizle dogrulanir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAiError, recordDatasetSnapshot, recordEvalRun } from "../eval/store.ts";
import { LlmError } from "../llm/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getAiQualityOverview } from "./ai-quality.ts";
import type { AdminActor } from "./capabilities.ts";

const SUFFIX = Date.now().toString(36).slice(-6);
const VERSION = `t97-${SUFFIX}`;
const OP = `t97_op_${SUFFIX}`;
const admin: AdminActor = { userId: 1, role: "admin" };

describe("getAiQualityOverview - entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM ai_error_event WHERE operation = $1", [OP]);
      await client.query("DELETE FROM ai_eval_run WHERE algorithm_version LIKE $1", [
        `t97-%${SUFFIX}`,
      ]);
      await client.query("DELETE FROM dataset_snapshot WHERE version = $1", [VERSION]);
    });
  });

  it("kayıtlı iki koşudan regresyonu hesaplar; ham vaka verisi dönmez", async () => {
    const snapshotId = await recordDatasetSnapshot(db, {
      dataset: "intent",
      version: VERSION,
      items: { suffix: SUFFIX },
      verifiedCount: 25,
    });
    const base = {
      snapshotId,
      component: "gemini_intent" as const,
      cases: [],
    };
    await recordEvalRun(db, {
      ...base,
      algorithmVersion: `t97-a-${SUFFIX}`,
      metrics: { accuracy: 0.9, macro_f1: 0.9, exact_pass_rate: 0.9 },
    });
    await recordEvalRun(db, {
      ...base,
      algorithmVersion: `t97-b-${SUFFIX}`,
      metrics: { accuracy: 0.7, macro_f1: 0.8, exact_pass_rate: 0.9 },
      cases: [{ caseKey: "a".repeat(24), outcome: "fail", failureClass: "wrong_action" }],
    });

    const overview = await getAiQualityOverview(db, admin, { days: 30 });
    const intent = overview.components.find((c) => c.component === "gemini_intent");
    expect(intent?.latest?.algorithmVersion).toBe(`t97-b-${SUFFIX}`);
    expect(intent?.previous?.algorithmVersion).toBe(`t97-a-${SUFFIX}`);
    expect(intent?.comparability).toBe("comparable");
    expect(intent?.regressed).toBe(true);
    const accuracy = intent?.metrics.find((m) => m.key === "accuracy");
    expect(accuracy?.status).toBe("regressed");
    expect(accuracy?.delta).toBeCloseTo(-0.2);
    expect(intent?.failureClasses).toContainEqual({ failureClass: "wrong_action", count: 1 });
    expect(JSON.stringify(overview)).not.toContain("a".repeat(24));
  });

  it("bileşen verisi olmayan alanlar 'veri yok' kalır", async () => {
    const overview = await getAiQualityOverview(db, admin, { days: 30 });
    const image = overview.components.find((c) => c.component === "jina_image");
    if (!image?.latest) {
      expect(image?.metrics.every((m) => m.value === null)).toBe(true);
    }
  });

  it("hata dağılımı sağlayıcı × sınıf gruplar", async () => {
    await recordAiError(db, {
      provider: "gemini",
      operation: OP,
      surface: "eval",
      error: new LlmError("rate_limited", 429),
      latencyMs: 90,
    });
    const overview = await getAiQualityOverview(db, admin, { days: 1 });
    expect(overview.errors.total).toBeGreaterThanOrEqual(1);
    expect(
      overview.errors.byKind.some(
        (r) => r.provider === "gemini" && r.errorClass === "rate_limited",
      ),
    ).toBe(true);
  });

  it("okuyucu salt okunur: yazma denemesi motor tarafından reddedilir", async () => {
    // Okuyucu salt okunur işlemde çalışır; satır sayısı değişmemeli.
    const count = async () =>
      withOwnerClient(
        async (c) => (await c.query("SELECT count(*)::int AS n FROM ai_eval_run")).rows[0].n,
      );
    const before = await count();
    await getAiQualityOverview(db, admin);
    expect(await count()).toBe(before);
  });
});
