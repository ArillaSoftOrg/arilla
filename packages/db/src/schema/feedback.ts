/** 0032_feedback.sql karsiligi. `/geri-bildirim` formu (docs/decisions/0045). */
import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const FEEDBACK_CATEGORIES = [
  "suggestion",
  "bug",
  "feature_request",
  "ux",
  "product_store",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_PRIORITIES = ["low", "medium", "high"] as const;
export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];

/** Uygulama bugun yalnizca `new` yazar; digerleri ileride yonetim paneli icindir. */
export type FeedbackStatus = "new" | "reviewing" | "planned" | "resolved" | "rejected";

/** Girisli gonderim `early_access`, anonim `public` (CHECK ile zorunlu). */
export type FeedbackSource = "public" | "early_access";

export const feedback = pgTable("feedback", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  /** Yalnizca sunucudaki oturumdan; anonimde NULL. Hesap silinince satir da silinir. */
  userId: bigint("user_id", { mode: "number" }),
  email: text("email"),
  category: text("category").$type<FeedbackCategory>().notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  priority: text("priority").$type<FeedbackPriority>(),
  status: text("status").$type<FeedbackStatus>().notNull().default("new"),
  source: text("source").$type<FeedbackSource>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
