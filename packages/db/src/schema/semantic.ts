/** 0004_semantic.sql karsiligi. */
import {
  bigint,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

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
