/** 0008_search.sql karsiligi. Detaylar docs/search.md. */
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** Ayristirma sonucu cache'i. Ayni sorgu iki kez modele gitmez. */
export const queryResolution = pgTable("query_resolution", {
  queryNorm: text("query_norm").primaryKey(),
  parsed: jsonb("parsed").notNull(),
  candidateCategories: bigint("candidate_categories", { mode: "number" }).array(),
  needsClarification: boolean("needs_clarification").notNull().default(false),
  /** 2 = sozluk, 3 = model. */
  parserTier: smallint("parser_tier").notNull(),
  hitCount: integer("hit_count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Sozlukler veritabaninda: yeni esanlamli icin surum cikmasin. */
export const lexicon = pgTable("lexicon", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  kind: text("kind")
    .$type<"color" | "category" | "brand" | "size" | "material" | "style" | "synonym">()
    .notNull(),
  /** 'spor ayakkabi' */
  surface: text("surface").notNull(),
  /** 'ayakkabi/sneaker' */
  normalized: text("normalized").notNull(),
  weight: real("weight").notNull().default(1.0),
});

/**
 * 0040: arama kalitesi gunluk ozeti (docs/decisions/0052). Kimlik YOK;
 * (gun, normalize sorgu) basina tek satir, 90 gun saklanir.
 */
export const searchQueryDay = pgTable(
  "search_query_day",
  {
    day: date("day", { mode: "string" }).notNull(),
    queryNorm: text("query_norm").notNull(),
    searches: integer("searches").notNull().default(0),
    zeroResults: integer("zero_results").notNull().default(0),
    fallbacks: integer("fallbacks").notNull().default(0),
    clarifications: integer("clarifications").notNull().default(0),
    lastResultCount: integer("last_result_count"),
    parserTier: smallint("parser_tier"),
    unrecognizedTerms: text("unrecognized_terms").array().notNull().default([]),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.day, table.queryNorm] })],
);

export type QueryInterpretationStatus = "accepted" | "empty" | "invalid";

/**
 * 0044: cevrimdisi model sorgu yorumu onbellegi (docs/decisions/0059).
 * Kimlik (query_norm, taxonomy_hash, model_version); kullanici/oturum YOK,
 * ham model yaniti YOK. Istek yolu yalnizca okur.
 */
export const queryInterpretation = pgTable(
  "query_interpretation",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    queryNorm: text("query_norm").notNull(),
    taxonomyHash: text("taxonomy_hash").notNull(),
    modelVersion: text("model_version").notNull(),
    status: text("status").$type<QueryInterpretationStatus>().notNull(),
    /** Dogrulanmis yorum; yalnizca `accepted`. */
    interpretation: jsonb("interpretation").$type<Record<string, unknown>>(),
    /** `validateInterpretation`'in sabit `{ path, reason }` kodlari. */
    rejected: jsonb("rejected").$type<{ path: string; reason: string }[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("query_interpretation_identity").on(
      table.queryNorm,
      table.taxonomyHash,
      table.modelVersion,
    ),
  ],
);
