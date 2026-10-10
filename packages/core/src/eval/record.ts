/**
 * Degerlendirme sonuclarini kalici kayda cevirir (Faz 1A-4, karar 0098).
 *
 * - Yalnizca `--record` ile ve YEREL veritabanina (`assertLocalRecordTarget`).
 * - Idempotent: ayni veri seti + bilesen + algoritma/model surumu + metrikler
 *   ikinci kez yazilmaz; var olan kosunun kimligi doner.
 * - Onceki kosuyla karsilastirma yalniz AYNI veri seti icerigi (snapshot) icin
 *   yapilir; veri seti degistiyse `baseline`/`regressed` bos kalir.
 * - Ham sorgu/metin/kullanici yazilmaz: vaka anahtari hash'tir, ayrinti bos.
 */
import { aiEvalCase, aiEvalRun, type Database, type EvalComponent } from "@arilla/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { COMPONENT_METRICS } from "./metric-keys.ts";
import { compareRuns } from "./metrics.ts";
import {
  type EvalCaseInput,
  recordDatasetSnapshot,
  recordEvalRun,
  type SnapshotInput,
} from "./store.ts";

/** Yerel olmayan adrese kayit yapilmaz (uzak/uretim DB'ye otomatik yazma yok). */
export function assertLocalRecordTarget(url: string | undefined): void {
  let host = "";
  try {
    host = new URL((url ?? "").trim()).hostname.toLowerCase();
  } catch {
    // asagida reddedilir
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("DATABASE_URL yerel degil; --record yalnizca yerel veritabanina yazar.");
  }
}

export interface RecordInput {
  component: EvalComponent;
  snapshot: SnapshotInput;
  algorithmVersion: string;
  modelVersion?: string;
  trigger?: "manual" | "ci" | "cron";
  metrics: Record<string, number>;
  cases: readonly EvalCaseInput[];
  durationMs?: number;
}

export type BaselineStatus = "compared" | "first_run" | "dataset_changed";

export interface RecordResult {
  runId: number;
  snapshotId: number;
  /** Ayni kosu zaten kayitliydi; yeni satir yazilmadi. */
  duplicate: boolean;
  baselineRunId: number | null;
  /** `dataset_changed`: bu bilesenin onceki kosulari baska veri seti icerigindeydi. */
  baselineStatus: BaselineStatus;
  regressed: boolean | null;
  regressedMetrics: string[];
}

const sameMetrics = (a: Record<string, number>, b: Record<string, number>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
};

/** Vaka sonuclarinin siradan bagimsiz imzasi (ayni metrik, farkli basarisiz vaka = farkli kosu). */
const caseSignature = (
  rows: readonly { caseKey: string; outcome: string; failureClass?: string | null }[],
) =>
  rows
    .map((r) => `${r.caseKey}|${r.outcome}|${r.failureClass ?? ""}`)
    .sort()
    .join("\n");

export async function recordEvaluation(db: Database, input: RecordInput): Promise<RecordResult> {
  const snapshotId = await recordDatasetSnapshot(db, input.snapshot);

  // Ayni anahtarla eszamanli iki kayit birbirini beklesin (idempotency yarisi).
  return db.transaction(async (tx) => {
    const lockKey = `${snapshotId}:${input.component}:${input.algorithmVersion}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const prior = await tx
      .select()
      .from(aiEvalRun)
      .where(and(eq(aiEvalRun.snapshotId, snapshotId), eq(aiEvalRun.component, input.component)))
      .orderBy(desc(aiEvalRun.id));

    const candidates = prior.filter(
      (r) =>
        r.algorithmVersion === input.algorithmVersion &&
        (r.modelVersion ?? null) === (input.modelVersion ?? null) &&
        !r.live &&
        sameMetrics(r.metrics, input.metrics),
    );
    const wantSignature = caseSignature(input.cases);
    for (const candidate of candidates) {
      const stored = await tx
        .select({
          caseKey: aiEvalCase.caseKey,
          outcome: aiEvalCase.outcome,
          failureClass: aiEvalCase.failureClass,
        })
        .from(aiEvalCase)
        .where(eq(aiEvalCase.runId, candidate.id));
      if (caseSignature(stored) === wantSignature) {
        return {
          runId: candidate.id,
          snapshotId,
          duplicate: true,
          baselineRunId: candidate.baselineRunId,
          baselineStatus: candidate.baselineRunId === null ? "first_run" : "compared",
          regressed: candidate.regressed,
          regressedMetrics: [],
        };
      }
    }

    // Temel cizgi: AYNI snapshot'taki en son kosu. Baska veri setindekiler sayilmaz.
    const baseline = prior[0] ?? null;
    let baselineStatus: BaselineStatus = baseline ? "compared" : "first_run";
    if (!baseline) {
      const [other] = await tx
        .select({ id: aiEvalRun.id })
        .from(aiEvalRun)
        .where(eq(aiEvalRun.component, input.component))
        .limit(1);
      if (other) baselineStatus = "dataset_changed";
    }
    let regressed: boolean | null = null;
    let regressedMetrics: string[] = [];
    if (baseline) {
      const directions = Object.fromEntries(
        COMPONENT_METRICS[input.component].map((s) => [s.key, s.direction]),
      );
      const changes = compareRuns(baseline.metrics, input.metrics, directions, 0.005);
      regressedMetrics = changes.filter((c) => c.regressed).map((c) => c.metric);
      regressed = regressedMetrics.length > 0;
    }

    const runId = await recordEvalRun(tx as unknown as Database, {
      snapshotId,
      component: input.component,
      algorithmVersion: input.algorithmVersion,
      modelVersion: input.modelVersion,
      trigger: input.trigger ?? "manual",
      live: false,
      baselineRunId: baseline?.id,
      regressed: regressed ?? undefined,
      metrics: input.metrics,
      durationMs: input.durationMs,
      cases: input.cases,
    });
    return {
      runId,
      snapshotId,
      duplicate: false,
      baselineRunId: baseline?.id ?? null,
      baselineStatus,
      regressed,
      regressedMetrics,
    };
  });
}
