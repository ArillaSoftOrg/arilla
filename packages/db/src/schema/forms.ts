/**
 * 0043_forms.sql karsiligi: form / anket merkezi (docs/decisions/0058).
 * Kisitlar (CHECK, kismi UNIQUE) migration'dadir; burada yalnizca kolonlar.
 */
import { bigint, boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const FORM_STATUSES = ["draft", "published", "closed"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FORM_AUDIENCES = ["public", "authenticated", "early_access"] as const;
export type FormAudience = (typeof FORM_AUDIENCES)[number];

export const FORM_KINDS = ["survey", "onboarding"] as const;
export type FormKind = (typeof FORM_KINDS)[number];

export const FORM_QUESTION_TYPES = [
  "single_choice",
  "multiple_choice",
  "short_text",
  "long_text",
] as const;
export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number];

/** Yanitin geldigi yer: dogrudan baglanti, onboarding yonlendirmesi, Hesabim. */
export const FORM_RESPONSE_SOURCES = ["link", "onboarding", "account"] as const;
export type FormResponseSource = (typeof FORM_RESPONSE_SOURCES)[number];

export const form = pgTable("form", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").$type<FormStatus>().notNull().default("draft"),
  audience: text("audience").$type<FormAudience>().notNull().default("public"),
  kind: text("kind").$type<FormKind>().notNull().default("survey"),
  allowSkip: boolean("allow_skip").notNull().default(false),
  allowMultipleResponses: boolean("allow_multiple_responses").notNull().default(false),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdBy: bigint("created_by", { mode: "number" }),
  updatedBy: bigint("updated_by", { mode: "number" }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const formQuestion = pgTable("form_question", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  formId: bigint("form_id", { mode: "number" }).notNull(),
  label: text("label").notNull(),
  description: text("description"),
  type: text("type").$type<FormQuestionType>().notNull(),
  required: boolean("required").notNull().default(false),
  sortOrder: integer("sort_order").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const formQuestionOption = pgTable("form_question_option", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  questionId: bigint("question_id", { mode: "number" }).notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const formResponse = pgTable("form_response", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  formId: bigint("form_id", { mode: "number" }).notNull(),
  /** Yalnizca sunucudaki oturumdan; anonimde NULL. Hesap silinince satir da silinir. */
  userId: bigint("user_id", { mode: "number" }),
  singleResponse: boolean("single_response").notNull(),
  source: text("source").$type<FormResponseSource>(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const formAnswer = pgTable("form_answer", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  responseId: bigint("response_id", { mode: "number" }).notNull(),
  questionId: bigint("question_id", { mode: "number" }).notNull(),
  optionId: bigint("option_id", { mode: "number" }),
  textValue: text("text_value"),
});

export const formSkip = pgTable("form_skip", {
  formId: bigint("form_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  skippedAt: timestamp("skipped_at", { withTimezone: true }).notNull().defaultNow(),
});
