/**
 * 0032_feedback.sql + 0047_feedback_contact.sql karsiligi. `/geri-bildirim`
 * (docs/decisions/0045) ve `/iletisim` (docs/decisions/0061) ayni tabloya
 * `kind` ile ayrilarak yazar.
 */
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

/** Iletisim formu kategorileri (0047 CHECK'i; `kind = 'contact'`). */
export const CONTACT_CATEGORIES = [
  "general",
  "account",
  "price_error",
  "bug",
  "partnership",
  "privacy",
  "other",
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

/** `feedback` = `/geri-bildirim`, `contact` = `/iletisim`. */
export type FeedbackKind = "feedback" | "contact";

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
  kind: text("kind").$type<FeedbackKind>().notNull().default("feedback"),
  /** Yalnizca iletisim formunda (yanit icin); geri bildirimde NULL. */
  name: text("name"),
  email: text("email"),
  /** Ture gore `FEEDBACK_CATEGORIES` ya da `CONTACT_CATEGORIES` (0047 CHECK'i). */
  category: text("category").$type<FeedbackCategory | ContactCategory>().notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  priority: text("priority").$type<FeedbackPriority>(),
  status: text("status").$type<FeedbackStatus>().notNull().default("new"),
  source: text("source").$type<FeedbackSource>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
