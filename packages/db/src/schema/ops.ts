/** 0041_job_run.sql karsiligi (docs/decisions/0052). */
import { bigint, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type JobRunStatus = "running" | "success" | "partial" | "failed";
export type JobRunTrigger = "manual" | "cron" | "worker";

/** Operasyonel is kosusu. Denetim/analitik/log DEGIL; `detail` kucuk ve sirsiz. */
export const jobRun = pgTable("job_run", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  /** `collect`, `resolve`, `enrich`, `similarity_prices`, ... (`^[a-z][a-z0-9_]{1,39}$`). */
  job: text("job").notNull(),
  trigger: text("trigger").$type<JobRunTrigger>().notNull().default("manual"),
  status: text("status").$type<JobRunStatus>().notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  errorSummary: text("error_summary"),
});
