/**
 * 0119_collection_schedule.sql karsiligi (karar 0221): yonetici tarayicisi toplamasinin
 * zamanlamasi. Kaynak basina tek satir; KAPALI gelir. CHECK kisitlari migration'dadir.
 */
import { bigint, boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type CollectionScheduleOutcome =
  | "completed"
  | "aborted"
  | "blocked"
  | "budget"
  | "interrupted"
  | "start_refused"
  | "error";

export const collectionSchedule = pgTable("collection_schedule", {
  source: text("source").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  targetUrls: jsonb("target_urls").$type<string[]>().notNull().default([]),
  paceSeconds: integer("pace_seconds").notNull().default(45),
  updatedBy: bigint("updated_by", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastRunId: bigint("last_run_id", { mode: "number" }),
  lastOutcome: text("last_outcome").$type<CollectionScheduleOutcome>(),
  lastErrorCode: text("last_error_code"),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
});
