/** 0063_data_intelligence.sql karsiligi (docs/decisions/0102). Kisitlar migration'dadir. */
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type DiDatasetKey =
  | "category_trends"
  | "brand_interest_trends"
  | "price_range_trends"
  | "alternative_search_trends";
export type DiBuildStatus = "ready" | "insufficient_data" | "blocked" | "failed";
export type DiExportStatus = "requested" | "completed" | "failed" | "cancelled";
export type DiLabelField = "category" | "brand";
export type DiLabelVerdict = "correct" | "incorrect" | "unsure";

/** Degismez, surumlu veri seti uretimi. Satirlar yalnizca k-esikli toplulastirilmis hucrelerdir. */
export const diDatasetBuild = pgTable("di_dataset_build", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  datasetKey: text("dataset_key").$type<DiDatasetKey>().notNull(),
  version: text("version").notNull(),
  specVersion: text("spec_version").notNull(),
  generatorVersion: text("generator_version").notNull(),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  status: text("status").$type<DiBuildStatus>().notNull(),
  statusReason: text("status_reason"),
  rowCount: integer("row_count").notNull().default(0),
  rows: jsonb("rows").$type<Record<string, string | number>[]>().notNull().default([]),
  contentSha256: text("content_sha256"),
  sourceMaxEventAt: timestamp("source_max_event_at", { withTimezone: true }),
  lineage: jsonb("lineage").$type<Record<string, unknown>>().notNull().default({}),
  qualityReport: jsonb("quality_report").$type<Record<string, unknown>>().notNull().default({}),
  anonymity: jsonb("anonymity").$type<Record<string, unknown>>().notNull().default({}),
  anonymityOk: boolean("anonymity_ok").notNull().default(false),
  createdBy: bigint("created_by", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface DiExportFile {
  name: string;
  bytes: number;
  sha256: string;
}

export const diExport = pgTable("di_export", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  buildId: bigint("build_id", { mode: "number" })
    .notNull()
    .references(() => diDatasetBuild.id),
  requestedBy: bigint("requested_by", { mode: "number" }),
  status: text("status").$type<DiExportStatus>().notNull().default("requested"),
  manifest: jsonb("manifest").$type<DiExportFile[]>().notNull().default([]),
  accuracySnapshot: jsonb("accuracy_snapshot")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  errorClass: text("error_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const diAccuracyLabel = pgTable("di_accuracy_label", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  buildId: bigint("build_id", { mode: "number" })
    .notNull()
    .references(() => diDatasetBuild.id),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  field: text("field").$type<DiLabelField>().notNull(),
  assignedValue: text("assigned_value").notNull(),
  sampleSeed: text("sample_seed").notNull(),
  verdict: text("verdict").$type<DiLabelVerdict>(),
  labeledBy: bigint("labeled_by", { mode: "number" }),
  labeledAt: timestamp("labeled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
