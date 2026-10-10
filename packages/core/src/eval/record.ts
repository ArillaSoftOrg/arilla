/**
 * Degerlendirme sonucunu kalici tablolara yazar (Faz 1A-4, karar 0098).
 *
 * Yalnizca acikca istenince (`--record`) cagrilir; varsayilan degerlendirme
 * veritabanina dokunmaz. Migration yok: 0060 tablolari kullanilir.
 *
 * - Ham sorgu/metin yazilmaz; vaka anahtari `caseKey` (SHA-256 onceki).
 * - Etiketli veri olmayan bilesen icin metrik uretilmez (cagiran kaydetmez).
 * - Karsilastirma yalniz AYNI veri seti icerigi (ayni snapshot) icindir; icerik
 *   degistiyse `regressed` NULL kalir ve temel cizgi atanmaz.
 * - Idempotent: ayni snapshot + bilesen + algoritma surumu + metrik + vaka sonuclari
 *   ikinci kez yazilmaz; var olan kosunun kimligi doner.
 */
import {
  aiEvalCase,
  aiEvalRun,
  type Database,
  type EvalComponent,
  type EvalDataset,
} from "@arilla/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { COMPONENT_METRICS } from "./metric-keys.ts";
import { compareRuns } from "./metrics.ts";
import { type EvalCaseInput, recordDatasetSnapshot, recordEvalRun } from "./store.ts";

/** Algoritma degisince elle artirilir; kosular bu surume gore ayirt edilir. */
export const EVAL_ALGORITHM_VERSIONS = {
  gemini_intent: "clarification-rules-v1",
  search: "text-search-v1",
} as const satisfies Partial<Record<EvalComponent, string>>;

export const DEFAULT_REGRESSION_TOLERANCE = 0.01;

export interface RecordEvalResultInput {
  component: EvalComponent;
  dataset: EvalDataset;
  /** Veri seti surum etiketi (insan okunur); icerik parmak izi ayrica hesaplanir. */
  datasetVersion: string;
  /** Altin set ogeleri: yalniz parmak izi icin, kaydedilmez. */
  items: unknown;
  verifiedCount: number;
  algorithmVersion: string;
  metrics: Record<string, number>;
  cases: readonly EvalCaseInput[];
  codeRef?: string;
  durationMs?: number;
  trigger?: "manual" | "ci" | "cron";
  tolerance?: number;
}

export type BaselineStatus = "compared" | "first_run" | "dataset_changed";

export interface RecordEvalResultOutcome {
  runId: number;
  /** true: ayni kosu zaten kayitliydi, yeni satir yazilmadi. */
  reused: boolean;
  snapshotId: number;
  baselineRunId: number | null;
  baselineStatus: BaselineStatus;
  regressed: boolean | null;
  changes: ReturnType<typeof compareRuns>;
}

type AiEvalRun = typeof aiEvalRun.$inferSelect;

const sameMetrics = (a: unknown, b: Record<string, number>) => {
  const left = (a ?? {}) as Record<string, number>;
  const keys = Object.keys(b);
  return (
    Object.keys(left).length === keys.length &&
    keys.every(
      (k) => typeof left[k] === "number" && Math.abs((left[k] as number) - (b[k] as number)) < 1e-9,
    )
  );
};

const caseSignature = (
  rows: readonly { caseKey: string; outcome: string; failureClass: string | null }[],
) =>
  rows
    .map((r) => `${r.caseKey}|${r.outcome}|${r.failureClass ?? ""}`)
    .sort()
    .join("\n");

export async function recordEvalResult(
  db: Database,
  input: RecordEvalResultInput,
): Promise<RecordEvalResultOutcome> {
  const snapshotId = await recordDatasetSnapshot(db, {
    dataset: input.dataset,
    version: input.datasetVersion,
    items: input.items,
    verifiedCount: input.verifiedCount,
    ...(input.codeRef ? { codeRef: input.codeRef } : {}),
  });
  const directions = Object.fromEntries(
    COMPONENT_METRICS[input.component].map((m) => [m.key, m.direction]),
  );
  const wantSignature = caseSignature(
    input.cases.map((c) => ({ ...c, failureClass: c.failureClass ?? null })),
  );

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('ai_eval_record'), ${snapshotId}::int)`,
    );

    const sameSnapshot: AiEvalRun[] = await tx
      .select()
      .from(aiEvalRun)
      .where(and(eq(aiEvalRun.component, input.component), eq(aiEvalRun.snapshotId, snapshotId)))
      .orderBy(desc(aiEvalRun.id));

    // Idempotency: ayni algoritma + metrik + vaka sonuclari.
    for (const prior of sameSnapshot) {
      if (
        prior.algorithmVersion !== input.algorithmVersion ||
        prior.live ||
        !sameMetrics(prior.metrics, input.metrics)
      ) {
        continue;
      }
      const priorCases = await tx
        .select({
          caseKey: aiEvalCase.caseKey,
          outcome: aiEvalCase.outcome,
          failureClass: aiEvalCase.failureClass,
        })
        .from(aiEvalCase)
        .where(eq(aiEvalCase.runId, prior.id));
      if (caseSignature(priorCases) === wantSignature) {
        return {
          runId: prior.id,
          reused: true,
          snapshotId,
          baselineRunId: prior.baselineRunId,
          baselineStatus:
            prior.baselineRunId === null ? ("first_run" as const) : ("compared" as const),
          regressed: prior.regressed,
          changes: [],
        };
      }
    }

    const baseline = sameSnapshot[0] ?? null;
    let baselineStatus: BaselineStatus = "first_run";
    if (!baseline) {
      const [anyPrior] = await tx
        .select({ id: aiEvalRun.id })
        .from(aiEvalRun)
        .where(eq(aiEvalRun.component, input.component))
        .limit(1);
      if (anyPrior) baselineStatus = "dataset_changed";
    }
    const changes = baseline
      ? compareRuns(
          baseline.metrics as Record<string, number>,
          input.metrics,
          directions,
          input.tolerance ?? DEFAULT_REGRESSION_TOLERANCE,
        )
      : [];
    if (baseline) baselineStatus = "compared";
    const regressed = baseline && changes.length > 0 ? changes.some((c) => c.regressed) : null;

    const runId = await recordEvalRun(txDb, {
      snapshotId,
      component: input.component,
      algorithmVersion: input.algorithmVersion,
      trigger: input.trigger ?? "manual",
      live: false,
      ...(baseline ? { baselineRunId: baseline.id } : {}),
      ...(regressed === null ? {} : { regressed }),
      metrics: input.metrics,
      ...(input.durationMs === undefined ? {} : { durationMs: Math.round(input.durationMs) }),
      cases: input.cases,
    });
    return {
      runId,
      reused: false,
      snapshotId,
      baselineRunId: baseline?.id ?? null,
      baselineStatus,
      regressed,
      changes,
    };
  });
}
