/** 0004_semantic.sql karsiligi (+ 0105 urun metin vektoru). */
import {
  bigint,
  boolean,
  customType,
  halfvec,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";
import { product } from "./catalog.ts";

/** Drizzle'in yerlesik bytea'si yok; yalnizca 16 baytlik ozetler icin. */
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const embedding = pgTable("embedding", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  targetType: text("target_type").$type<"offer" | "product" | "query">().notNull(),
  targetId: bigint("target_id", { mode: "number" }).notNull(),
  kind: text("kind").$type<"image" | "text">().notNull(),
  /** Her satirda model surumu. Model degisimi katalogu cope atmaz. */
  modelVersion: text("model_version").notNull(),
  vector: vector("vector", { dimensions: 768 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matchCandidate = pgTable("match_candidate", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  score: real("score").notNull(),
  method: text("method").$type<"gtin" | "mpn" | "text" | "image" | "hybrid">().notNull(),
  status: text("status")
    .$type<"pending" | "auto_accepted" | "accepted" | "rejected">()
    .notNull()
    .default("pending"),
  reviewedBy: bigint("reviewed_by", { mode: "number" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /** 0028: red nedeni; NULL = belirtilmedi. `superseded` onayin kardesleri icin. */
  reviewReason: text("review_reason").$type<
    "not_same_product" | "different_color" | "different_size" | "bad_data" | "other" | "superseded"
  >(),
  /** 0028: resolver'in skor aciklamasi (yontem, metin benzerligi, inceleme nedeni). */
  explain: jsonb("explain"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Istek yolu alternatifleri SADECE buradan okur. */
export const similarityEdge = pgTable(
  "similarity_edge",
  {
    productA: bigint("product_a", { mode: "number" }).notNull(),
    productB: bigint("product_b", { mode: "number" }).notNull(),
    kind: text("kind").$type<"same" | "visual" | "semantic" | "substitute">().notNull(),
    score: real("score").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.productA, table.productB, table.kind] })],
);

/** Uretilmis ve saklanan AI ciktilari. Bir kez uretilir, bin kez okunur. */
export const generatedContent = pgTable("generated_content", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  targetType: text("target_type").notNull(),
  targetId: bigint("target_id", { mode: "number" }).notNull(),
  kind: text("kind").$type<"attribute_extract" | "description" | "comparison">().notNull(),
  modelVersion: text("model_version").notNull(),
  content: jsonb("content").notNull(),
  /** Girdi degismediyse yeniden uretme. */
  inputHash: text("input_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 0105 (karar 0177): urun duzeyinde metin vektoru, `embedding`ten ayri. Yazan yalnizca Python
 * `enrich.products`; TypeScript okur. Benzerlik urun kimligi kaniti DEGILDIR.
 */
export const productTextEmbedding = pgTable(
  "product_text_embedding",
  {
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    /** Sorgu vektoru AYNI modelle (`retrieval.query`) uretilmelidir. */
    modelVersion: text("model_version").notNull(),
    textVersion: smallint("text_version").notNull(),
    contentHash: bytea("content_hash").notNull(),
    sourceHash: bytea("source_hash").notNull(),
    embedding: halfvec("embedding", { dimensions: 768 }).notNull(),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.modelVersion] }),
    index("product_text_embedding_hash_idx").on(table.modelVersion, table.contentHash),
  ],
);

/**
 * 0108 (karar 0178): anlamsal arama golge olcumu. Yalniz sayisal olculer; sorgu metni, ozeti,
 * kullanici/oturum ve urun kimligi yok. Yazan `packages/core` `search/semantic/shadow.ts`.
 */
export const semanticShadowEvent = pgTable(
  "semantic_shadow_event",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome")
      .$type<"measured" | "no_vector" | "ineligible" | "capped" | "error">()
      .notNull(),
    reason: text("reason"),
    modelVersion: text("model_version").notNull(),
    textCount: integer("text_count").notNull(),
    textWithVector: integer("text_with_vector").notNull().default(0),
    candidateCount: integer("candidate_count").notNull().default(0),
    bestSimilarity: real("best_similarity"),
    gatePassed: integer("gate_passed").notNull().default(0),
    semanticOnly: integer("semantic_only").notNull().default(0),
    topN: smallint("top_n").notNull(),
    overlapTopN: smallint("overlap_top_n").notNull().default(0),
    newInTopN: smallint("new_in_top_n").notNull().default(0),
    embedMs: integer("embed_ms"),
    knnMs: integer("knn_ms"),
    cacheHit: boolean("cache_hit"),
  },
  (table) => [index("semantic_shadow_event_created_idx").on(table.createdAt)],
);
