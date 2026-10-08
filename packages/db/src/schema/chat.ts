/** 0054_conversation.sql karsiligi (docs/decisions/0074). */
import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres BYTEA <-> Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export type ChatMessageRole = "user" | "assistant";
export type ChatMessageKind = "text" | "option" | "skip" | "clarify" | "search" | "notice";

/** Kullanicinin kendi sohbeti. Sahiplik her sorguda `user_id` ile denetlenir. */
export const conversation = pgTable("conversation", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  /** Normalize edilmis, birlestirilmis `SearchIntent`; sekli core'da dogrulanir. */
  currentSearchIntent: jsonb("current_search_intent").$type<Record<string, unknown>>(),
  /** Acik netlestirme sorusu; core'daki `ClarifyQuestion` sekli. */
  pendingQuestion: jsonb("pending_question").$type<Record<string, unknown>>(),
  title: text("title").notNull(),
  /** Model cagrisi suresince bir turu sahiplenen kira. */
  processingUntil: timestamp("processing_until", { withTimezone: true }),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Eklenir, degistirilmez (arilla_app'ten UPDATE geri alindi). */
export const chatMessage = pgTable("chat_message", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").$type<ChatMessageRole>().notNull(),
  kind: text("kind").$type<ChatMessageKind>().notNull(),
  content: text("content").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 0055: bir arama mesajinin sonuc blogu icin tek evet/hayir oyu. Metin tasimaz. */
export const chatResultFeedback = pgTable("chat_result_feedback", {
  messageId: bigint("message_id", { mode: "number" }).primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  helpful: boolean("helpful").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 0057 (karar 0078): ilk mesaja eklenen on islenmis urun fotografi. Mesaj
 * `payload.attachmentId` ile baglanir. Sohbetle birlikte silinir; yalnizca sahibine sunulur.
 */
export const chatAttachment = pgTable("chat_attachment", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  mimeType: text("mime_type").$type<"image/jpeg" | "image/png">().notNull(),
  data: bytea("data").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
