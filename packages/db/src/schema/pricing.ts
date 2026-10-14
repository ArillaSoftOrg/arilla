/**
 * 0067_price_verification_fx.sql karsiligi (karar 0113): resmi kur, bagimsiz
 * fiyat dogrulama sonucu ve dogrulama kuyrugu.
 *
 * Indeksler ve CHECK kisitlari burada TEKRARLANMAZ; tek sahibi migration'dir.
 */
import {
  bigint,
  boolean,
  char,
  date,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** APPEND-ONLY: 1 birim `base` = `rate` birim `quote`; kaynak tarihli. */
export const fxRate = pgTable("fx_rate", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  source: text("source").$type<"tcmb">().notNull(),
  base: char("base", { length: 3 }).notNull(),
  quote: char("quote", { length: 3 }).notNull(),
  rate: numeric("rate", { precision: 20, scale: 8 }).notNull(),
  rateKind: text("rate_kind").$type<"forex_selling" | "forex_buying">().notNull(),
  effectiveDate: date("effective_date").notNull(),
  bulletin: text("bulletin"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationResult = "match" | "mismatch" | "unavailable" | "error";

/** APPEND-ONLY: beslemeden bagimsiz dogrulama sonucu. */
export const priceVerification = pgTable("price_verification", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  offerVariantId: bigint("offer_variant_id", { mode: "number" }),
  sellerId: bigint("seller_id", { mode: "number" }),
  provider: text("provider").notNull(),
  sourceKind: text("source_kind")
    .$type<"merchant_storefront" | "merchant_api" | "affiliate_api">()
    .notNull(),
  sourceReliability: smallint("source_reliability").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  result: text("result").$type<VerificationResult>().notNull(),
  currency: char("currency", { length: 3 }),
  observedPriceMinor: bigint("observed_price_minor", { mode: "number" }),
  listPriceMinor: bigint("list_price_minor", { mode: "number" }),
  feedPriceMinor: bigint("feed_price_minor", { mode: "number" }),
  inStock: boolean("in_stock"),
  shippingMinor: bigint("shipping_minor", { mode: "number" }),
  taxIncluded: boolean("tax_included"),
  discountConditions: jsonb("discount_conditions").$type<Record<string, unknown>>(),
  couponConditions: jsonb("coupon_conditions").$type<Record<string, unknown>>(),
  errorCode: text("error_code"),
});

/** Dogrulama kuyrugu; TS yalnizca satir ekler, Python iscisi isler. */
export const priceVerificationRequest = pgTable("price_verification_request", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  reason: text("reason").$type<"stale" | "viewed" | "manual" | "price_change">().notNull(),
  priority: smallint("priority").notNull().default(0),
  status: text("status")
    .$type<"pending" | "running" | "done" | "failed" | "unsupported">()
    .notNull()
    .default("pending"),
  attempts: smallint("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  verificationId: bigint("verification_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
