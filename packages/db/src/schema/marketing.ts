/** 0033_marketing_email.sql karsiligi (docs/decisions/0046). */
import { bigint, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Adres duzeyinde pazarlama bastirmasi. APPEND-ONLY: arilla_app yalnizca
 * SELECT + INSERT. Adres duz metin tutulmaz, normalize adresin SHA-256 ozeti.
 */
export const emailSuppression = pgTable("email_suppression", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  emailHash: text("email_hash").notNull(),
  channel: text("channel").$type<"marketing">().notNull().default("marketing"),
  reason: text("reason").$type<"unsubscribe_link" | "admin" | "bounce" | "complaint">().notNull(),
  userId: bigint("user_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Kampanya basina alici basina tek satir; token yalnizca ozetiyle durur. */
export const marketingEmailSend = pgTable("marketing_email_send", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  campaignKey: text("campaign_key").notNull(),
  userId: bigint("user_id", { mode: "number" }),
  emailHash: text("email_hash").notNull(),
  consentId: bigint("consent_id", { mode: "number" }),
  unsubscribeTokenHash: text("unsubscribe_token_hash").notNull(),
  status: text("status").$type<"pending" | "sent" | "failed">().notNull().default("pending"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

/** Riza olayinin dis sistemle (IYS) senkron durumu. */
export const consentExternalSync = pgTable(
  "consent_external_sync",
  {
    consentId: bigint("consent_id", { mode: "number" }).notNull(),
    provider: text("provider").$type<"iys">().notNull(),
    status: text("status").$type<"pending" | "synced" | "failed">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    externalRef: text("external_ref"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consentId, table.provider] })],
);
