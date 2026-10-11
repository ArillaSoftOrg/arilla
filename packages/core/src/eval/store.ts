/**
 * Degerlendirme ve hata veri seti yazimi/okumasi (migration 0060, karar 0096).
 *
 * Kurallar:
 * 1. Ham sorgu, sohbet metni, gorsel, kullanici/oturum kimligi YAZILMAZ.
 *    Vaka kimligi fixture metninin SHA-256 onekidir (`caseKey`).
 * 2. Hata olayi yazimi isi asla dusurmez (`job-run.ts` ile ayni ilke).
 * 3. Maliyet `api_usage`ta kalir; kosu satirindaki `costMicros` yalnizca ozet.
 * 4. Gercek API cagrisi yapmaz; saf siniflandirici + veritabani yazicisi.
 */
import { createHash } from "node:crypto";
import {
  type AiErrorClass,
  type AiProvider,
  type AiSurface,
  aiErrorEvent,
  aiEvalCase,
  aiEvalRun,
  type Database,
  datasetSnapshot,
  type EvalComponent,
  type EvalDataset,
  type EvalOutcome,
} from "@arilla/db";
import { desc, eq, sql } from "drizzle-orm";
import { EmbeddingError } from "../embedding/client.ts";
import { LlmError } from "../llm/client.ts";
import { redactJobError } from "../ops/job-run.ts";

export const AI_ERROR_SUMMARY_MAX = 300;
export const AI_ERROR_RETENTION_DAYS = 180;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Fixture metni icin kararli, geri cevrilemeyen vaka anahtari (24 hex). */
export function caseKey(dataset: EvalDataset, text: string): string {
  return sha256(`${dataset}\u0000${text.normalize("NFC").trim()}`).slice(0, 24);
}

/** Anahtar sirasindan bagimsiz kanonik JSON; ayni icerik ayni parmak izi. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function datasetFingerprint(items: unknown): string {
  return sha256(canonical(items));
}

export interface ClassifiedError {
  errorClass: AiErrorClass;
  httpStatus: number | null;
}

const LLM_CLASS: Record<string, AiErrorClass> = {
  missing_api_key: "auth",
  auth: "auth",
  timeout: "timeout",
  network: "network",
  rate_limited: "rate_limited",
  server_error: "server_error",
  client_error: "bad_request",
  incomplete: "empty_output",
  malformed_response: "schema_invalid",
  invalid_json: "schema_invalid",
};

function fromStatus(status: number): AiErrorClass {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status >= 500) return "server_error";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** Gemini/Jina hatasini sabit sinif kumesine indirger. Mesaj metni kaydedilmez. */
export function classifyAiError(error: unknown): ClassifiedError {
  if (error instanceof LlmError) {
    // Saglayicinin sabit durum degeri guvenlik engelini gosteriyorsa ayri sinif.
    if (error.detail && /SAFETY|BLOCKLIST|PROHIBITED|RECITATION|BLOCKED/i.test(error.detail)) {
      return { errorClass: "safety_blocked", httpStatus: error.httpStatus };
    }
    return { errorClass: LLM_CLASS[error.code] ?? "unknown", httpStatus: error.httpStatus };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { errorClass: "timeout", httpStatus: null };
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = /\b(?:HTTP|status)\D{0,3}([1-5]\d\d)\b/i.exec(message)?.[1];
  if (status) return { errorClass: fromStatus(Number(status)), httpStatus: Number(status) };
  if (error instanceof EmbeddingError && /timeout|zaman a/i.test(message)) {
    return { errorClass: "timeout", httpStatus: null };
  }
  if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(message)) {
    return { errorClass: "network", httpStatus: null };
  }
  return { errorClass: "unknown", httpStatus: null };
}

export interface AiErrorInput {
  provider: AiProvider;
  operation: string;
  surface: AiSurface;
  error: unknown;
  latencyMs?: number;
  modelVersion?: string;
  apiUsageId?: number;
  jobRunId?: number;
}

/** Hata olayini yazar. ASLA firlatmaz; yazilamazsa `false` doner. */
export async function recordAiError(db: Database, input: AiErrorInput): Promise<boolean> {
  try {
    const { errorClass, httpStatus } = classifyAiError(input.error);
    await db.insert(aiErrorEvent).values({
      provider: input.provider,
      operation: input.operation,
      surface: input.surface,
      errorClass,
      httpStatus,
      latencyMs: input.latencyMs === undefined ? null : Math.max(0, Math.round(input.latencyMs)),
      modelVersion: input.modelVersion?.slice(0, 80) ?? null,
      apiUsageId: input.apiUsageId ?? null,
      jobRunId: input.jobRunId ?? null,
      errorSummary: redactJobError(
        input.error instanceof Error ? input.error.message : String(input.error ?? ""),
        AI_ERROR_SUMMARY_MAX,
      ),
    });
    return true;
  } catch {
    console.warn("ai_error_event yazilamadi");
    return false;
  }
}

export interface SnapshotInput {
  dataset: EvalDataset;
  version: string;
  /** Altin set ogeleri (kanonik parmak izi icin); ham metin kaydedilmez. */
  items: unknown;
  verifiedCount: number;
  candidateCount?: number;
  codeRef?: string;
}

/** Ayni icerik ikinci kez kaydedilmez; var olan satirin kimligini doner. */
export async function recordDatasetSnapshot(db: Database, input: SnapshotInput): Promise<number> {
  const contentSha256 = datasetFingerprint(input.items);
  await db
    .insert(datasetSnapshot)
    .values({
      dataset: input.dataset,
      version: input.version,
      contentSha256,
      verifiedCount: input.verifiedCount,
      candidateCount: input.candidateCount ?? 0,
      codeRef: input.codeRef ?? null,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: datasetSnapshot.id })
    .from(datasetSnapshot)
    .where(
      sql`${datasetSnapshot.dataset} = ${input.dataset} AND ${datasetSnapshot.contentSha256} = ${contentSha256}`,
    );
  if (!row) throw new Error("dataset_snapshot okunamadi");
  return row.id;
}

export interface EvalCaseInput {
  caseKey: string;
  outcome: EvalOutcome;
  failureClass?: string;
  score?: number;
  latencyMs?: number;
  detail?: Record<string, unknown>;
}

export interface EvalRunInput {
  snapshotId: number;
  component: EvalComponent;
  algorithmVersion: string;
  modelVersion?: string;
  trigger?: "manual" | "ci" | "cron";
  live?: boolean;
  jobRunId?: number;
  baselineRunId?: number;
  regressed?: boolean;
  metrics: Record<string, number>;
  apiCalls?: number;
  costMicros?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  durationMs?: number;
  cases: readonly EvalCaseInput[];
}

/** Kosuyu ve vakalarini tek islemde yazar. */
export async function recordEvalRun(db: Database, input: EvalRunInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(aiEvalRun)
      .values({
        snapshotId: input.snapshotId,
        component: input.component,
        algorithmVersion: input.algorithmVersion,
        modelVersion: input.modelVersion ?? null,
        trigger: input.trigger ?? "manual",
        live: input.live ?? false,
        jobRunId: input.jobRunId ?? null,
        baselineRunId: input.baselineRunId ?? null,
        regressed: input.regressed ?? null,
        metrics: input.metrics,
        apiCalls: input.apiCalls ?? 0,
        costMicros: input.costMicros ?? 0,
        latencyP50Ms: input.latencyP50Ms ?? null,
        latencyP95Ms: input.latencyP95Ms ?? null,
        durationMs: input.durationMs ?? null,
      })
      .returning({ id: aiEvalRun.id });
    if (!run) throw new Error("ai_eval_run yazilamadi");
    if (input.cases.length > 0) {
      await tx.insert(aiEvalCase).values(
        input.cases.map((c) => ({
          runId: run.id,
          caseKey: c.caseKey,
          outcome: c.outcome,
          failureClass: c.failureClass ?? null,
          score: c.score ?? null,
          latencyMs: c.latencyMs ?? null,
          detail: c.detail ?? {},
        })),
      );
    }
    return run.id;
  });
}

/** Bir bilesenin son kosusu (regresyon karsilastirmasinin temel cizgisi). */
export async function latestEvalRun(db: Database, component: EvalComponent, snapshotId?: number) {
  const [row] = await db
    .select()
    .from(aiEvalRun)
    .where(
      snapshotId === undefined
        ? eq(aiEvalRun.component, component)
        : sql`${aiEvalRun.component} = ${component} AND ${aiEvalRun.snapshotId} = ${snapshotId}`,
    )
    .orderBy(desc(aiEvalRun.id))
    .limit(1);
  return row ?? null;
}

export interface ErrorBreakdownRow {
  provider: string;
  errorClass: string;
  count: number;
  p95LatencyMs: number | null;
}

/** Son `days` gundeki hata dagilimi (saglayici x sinif). */
export async function aiErrorBreakdown(db: Database, days = 7): Promise<ErrorBreakdownRow[]> {
  const result = await db.execute<{
    provider: string;
    error_class: string;
    n: string;
    p95: string | null;
  }>(sql`
    SELECT provider, error_class, count(*)::text AS n,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::text AS p95
      FROM ai_error_event
     WHERE occurred_at >= now() - make_interval(days => ${days})
     GROUP BY provider, error_class
     ORDER BY count(*) DESC
  `);
  return result.rows.map((r) => ({
    provider: r.provider,
    errorClass: r.error_class,
    count: Number(r.n),
    p95LatencyMs: r.p95 === null ? null : Number(r.p95),
  }));
}

/**
 * Eslestirme ret nedenleri dagilimi. Yeni tablo yok: kaynak
 * `match_candidate.review_reason` (0028). Insan kararidir, model hatasi degil.
 */
export async function matchRejectionBreakdown(
  db: Database,
  days = 30,
): Promise<{ reason: string; count: number }[]> {
  const result = await db.execute<{ reason: string; n: string }>(sql`
    SELECT COALESCE(review_reason, 'unspecified') AS reason, count(*)::text AS n
      FROM match_candidate
     WHERE status = 'rejected' AND reviewed_at >= now() - make_interval(days => ${days})
     GROUP BY 1 ORDER BY count(*) DESC
  `);
  return result.rows.map((r) => ({ reason: r.reason, count: Number(r.n) }));
}

/** 180 gunden eski hata olaylarini siler (diger tablolar degistirilemez). */
export async function purgeAiErrorEvents(db: Database): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM ai_error_event
     WHERE occurred_at < now() - make_interval(days => ${AI_ERROR_RETENTION_DAYS})
  `);
  return result.rowCount ?? 0;
}
