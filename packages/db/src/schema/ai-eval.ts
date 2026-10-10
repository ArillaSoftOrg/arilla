/** 0060_ai_eval.sql karsiligi (docs/decisions/0096). */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { apiUsage } from "./attribution.ts";
import { jobRun } from "./ops.ts";

export type EvalDataset = "matching" | "search" | "intent" | "image";
export type EvalComponent = "gemini_intent" | "jina_image" | "matching" | "search";
export type EvalOutcome = "pass" | "fail" | "error" | "skipped";
export type AiProvider = "gemini" | "jina" | "other";
export type AiSurface = "chat" | "search" | "ingest" | "enrich" | "eval";
export type AiErrorClass =
  | "timeout"
  | "rate_limited"
  | "quota"
  | "auth"
  | "bad_request"
  | "schema_invalid"
  | "safety_blocked"
  | "empty_output"
  | "server_error"
  | "network"
  | "unknown";

/** Degismez veri seti anlik goruntusu; icerik depoda, burada yalnizca parmak izi. */
export const datasetSnapshot = pgTable("dataset_snapshot", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  dataset: text("dataset").$type<EvalDataset>().notNull(),
  version: text("version").notNull(),
  contentSha256: text("content_sha256").notNull(),
  verifiedCount: integer("verified_count").notNull(),
  candidateCount: integer("candidate_count").notNull().default(0),
  codeRef: text("code_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiEvalRun = pgTable("ai_eval_run", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  snapshotId: bigint("snapshot_id", { mode: "number" })
    .notNull()
    .references(() => datasetSnapshot.id),
  component: text("component").$type<EvalComponent>().notNull(),
  algorithmVersion: text("algorithm_version").notNull(),
  modelVersion: text("model_version"),
  trigger: text("trigger").$type<"manual" | "ci" | "cron">().notNull().default("manual"),
  live: boolean("live").notNull().default(false),
  jobRunId: bigint("job_run_id", { mode: "number" }).references(() => jobRun.id, {
    onDelete: "set null",
  }),
  baselineRunId: bigint("baseline_run_id", { mode: "number" }),
  regressed: boolean("regressed"),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
  apiCalls: integer("api_calls").notNull().default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  latencyP50Ms: integer("latency_p50_ms"),
  latencyP95Ms: integer("latency_p95_ms"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiEvalCase = pgTable("ai_eval_case", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  runId: bigint("run_id", { mode: "number" })
    .notNull()
    .references(() => aiEvalRun.id, { onDelete: "cascade" }),
  caseKey: text("case_key").notNull(),
  outcome: text("outcome").$type<EvalOutcome>().notNull(),
  failureClass: text("failure_class"),
  score: real("score"),
  latencyMs: integer("latency_ms"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
});

/** Model cagrisi hatasi. Kullanici, oturum ve istem/yanit metni YOKTUR. */
export const aiErrorEvent = pgTable("ai_error_event", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  provider: text("provider").$type<AiProvider>().notNull(),
  operation: text("operation").notNull(),
  surface: text("surface").$type<AiSurface>().notNull(),
  errorClass: text("error_class").$type<AiErrorClass>().notNull(),
  httpStatus: smallint("http_status"),
  latencyMs: integer("latency_ms"),
  modelVersion: text("model_version"),
  apiUsageId: bigint("api_usage_id", { mode: "number" }).references(() => apiUsage.id, {
    onDelete: "set null",
  }),
  jobRunId: bigint("job_run_id", { mode: "number" }).references(() => jobRun.id, {
    onDelete: "set null",
  }),
  errorSummary: text("error_summary"),
});
