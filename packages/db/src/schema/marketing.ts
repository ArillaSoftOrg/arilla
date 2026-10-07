/**
 * 0035_marketing_campaign.sql karsiligi (docs/decisions/0048): pazarlama
 * e-postasi kampanyasi ve alici basina teslim kaydi. Kisitlar (CHECK,
 * UNIQUE (campaign_id, user_id)) migration'dadir; burada yalnizca kolonlar.
 *
 * Alici adresi SAKLANMAZ: gonderim aninda `app_user.email`'den okunur.
 */
import { bigint, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

export type MarketingCampaignStatus =
  | "draft"
  | "sending"
  | "completed"
  | "partially_failed"
  | "failed"
  | "cancelled";

export type MarketingDeliveryState = "pending" | "sending" | "sent" | "failed" | "skipped";

export type MarketingFailureCode =
  | "invalid_recipient"
  | "provider_rejected"
  | "temporary_error"
  | "configuration_error"
  | "unknown_outcome";

export type MarketingSkipReason = "not_eligible" | "account_deleted" | "cancelled";

export const marketingCampaign = pgTable("marketing_campaign", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  publicId: uuid("public_id").notNull().defaultRandom(),
  title: text("title").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: text("status").$type<MarketingCampaignStatus>().notNull().default("draft"),
  contentVersion: integer("content_version").notNull().default(1),
  testedVersion: integer("tested_version"),
  createdBy: bigint("created_by", { mode: "number" }),
  updatedBy: bigint("updated_by", { mode: "number" }),
  sendRequestedBy: bigint("send_requested_by", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  recipientCount: integer("recipient_count"),
  lastErrorCode: text("last_error_code"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
});

export const marketingCampaignDelivery = pgTable("marketing_campaign_delivery", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  /** Hesap silinince NULL; bekleyen teslim `account_deleted` ile atlanir. */
  userId: bigint("user_id", { mode: "number" }),
  state: text("state").$type<MarketingDeliveryState>().notNull().default("pending"),
  attemptCount: smallint("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  providerMessageId: text("provider_message_id"),
  failureCode: text("failure_code").$type<MarketingFailureCode>(),
  skipReason: text("skip_reason").$type<MarketingSkipReason>(),
  providerErrorCode: text("provider_error_code"),
  /** Abonelik iptal token'inin SHA-256 ozeti; ham token yalnizca e-postada. */
  unsubscribeTokenHash: text("unsubscribe_token_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
