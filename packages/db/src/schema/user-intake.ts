/** 0013_user_intake.sql karsiligi. D4: gorsel arama + kok catch-all link cozumleme. */
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Yuklenen gorselin izi. CLAUDE.md kural 1'in tek istisnasi: istek yolundaki
 * tek model cagrisi, EmbeddingService arkasindan ve image_hash ile
 * cache'lenerek yapilir. KVKK: ham dosya en fazla 30 gun kalir, purge_after
 * gecince object_key NULL'a cekilir.
 */
export const imageUpload = pgTable("image_upload", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }),
  sessionId: text("session_id").notNull(),
  /** sha256 — embedding cache anahtari. */
  imageHash: text("image_hash").notNull(),
  /** Purge sonrasi NULL. */
  objectKey: text("object_key"),
  hasFace: boolean("has_face").notNull().default(false),
  status: text("status")
    .$type<"pending" | "embedded" | "rejected_not_product" | "rejected_moderation">()
    .notNull()
    .default("pending"),
  rejectionReason: text("rejection_reason"),
  embeddingId: bigint("embedding_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  purgeAfter: timestamp("purge_after", { withTimezone: true }).notNull(),
});

/**
 * Kok catch-all'in tekil link cozumleme durumu. docs/decisions/0014: tek
 * cozumleme ingest_run yazmaz; bekleme ekrani bu satiri poll'lar.
 * offer_id doluyken offer.product_id henuz NULL olabilir (B4 ayri calisir).
 */
export const linkResolutionRequest = pgTable("link_resolution_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  urlRaw: text("url_raw").notNull(),
  sessionId: text("session_id").notNull(),
  userId: bigint("user_id", { mode: "number" }),
  status: text("status")
    .$type<"queued" | "processing" | "resolved" | "failed">()
    .notNull()
    .default("queued"),
  offerId: bigint("offer_id", { mode: "number" }),
  errorText: text("error_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
