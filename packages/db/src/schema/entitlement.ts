/**
 * 0034_search_entitlement.sql karsiligi (docs/decisions/0047): gunluk arama
 * hakki, bonus hak, pahali arama harcama kaydi, davet ve append-only bonus
 * defteri. Kisitlar (CHECK, kismi UNIQUE) migration'dadir; burada yalnizca
 * kolonlar tanimlanir.
 */
import {
  bigint,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type AiSearchOperation = "visual_search" | "link_search";
export type AiSearchChargeState = "reserved" | "settled" | "refunded";
export type BonusLedgerReason =
  | "search_charge"
  | "search_refund"
  | "referral_inviter"
  | "referral_invitee"
  | "feedback_first"
  | "admin_grant"
  | "campaign";
export type ReferralStatus = "pending" | "qualified";

export const aiQuotaDay = pgTable(
  "ai_quota_day",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
    /** Europe/Istanbul takvim gunu (YYYY-MM-DD). */
    day: date("day").notNull(),
    dailyLimit: integer("daily_limit").notNull(),
    used: integer("used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.day] }),
  }),
);

export const bonusAccount = pgTable("bonus_account", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  balance: integer("balance").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiSearchCharge = pgTable("ai_search_charge", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  operation: text("operation").$type<AiSearchOperation>().notNull(),
  requestKey: text("request_key").notNull(),
  cost: integer("cost").notNull(),
  day: date("day").notNull(),
  fromDaily: integer("from_daily").notNull(),
  fromBonus: integer("from_bonus").notNull(),
  state: text("state").$type<AiSearchChargeState>().notNull().default("reserved"),
  imageUploadId: bigint("image_upload_id", { mode: "number" }),
  linkRequestId: uuid("link_request_id"),
  refundReason: text("refund_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
});

export const referral = pgTable("referral", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  inviterUserId: bigint("inviter_user_id", { mode: "number" }),
  inviteeUserId: bigint("invitee_user_id", { mode: "number" }).notNull(),
  status: text("status").$type<ReferralStatus>().notNull().default("pending"),
  qualifyingChargeId: uuid("qualifying_charge_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
});

/** Append-only: arilla_app yalnizca SELECT + INSERT. */
export const bonusLedger = pgTable("bonus_ledger", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  delta: integer("delta").notNull(),
  requested: integer("requested").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  reason: text("reason").$type<BonusLedgerReason>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  chargeId: uuid("charge_id"),
  referralId: bigint("referral_id", { mode: "number" }),
  actorUserId: bigint("actor_user_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
