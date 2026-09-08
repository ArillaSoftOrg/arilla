/** 0007_attribution.sql karsiligi. */
import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Merchant'a giden her cikis buradan gecer. Attribution kaydi olmadan link yok. */
export const click = pgTable("click", {
  /** click_id — deeplink icinde tasinir. */
  id: uuid("id").primaryKey().defaultRandom(),
  userId: bigint("user_id", { mode: "number" }),
  sessionId: text("session_id").notNull(),
  creatorId: bigint("creator_id", { mode: "number" }),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }),
  channel: text("channel").$type<"web" | "mcp" | "extension" | "api" | "prefix_link">().notNull(),
  surface: text("surface"),
  priceAtClick: bigint("price_at_click", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversion = pgTable("conversion", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  clickId: uuid("click_id"),
  merchantId: bigint("merchant_id", { mode: "number" }).notNull(),
  creatorId: bigint("creator_id", { mode: "number" }),
  externalOrderId: text("external_order_id"),
  orderValue: bigint("order_value", { mode: "number" }).notNull(),
  commission: bigint("commission", { mode: "number" }),
  status: text("status")
    .$type<"pending" | "confirmed" | "cancelled" | "paid">()
    .notNull()
    .default("pending"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Her model cagrisi buraya yazilir. Maliyet olculemiyorsa kontrol edilemez. */
export const apiUsage = pgTable("api_usage", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  sessionId: text("session_id"),
  userId: bigint("user_id", { mode: "number" }),
  b2bClientId: bigint("b2b_client_id", { mode: "number" }),
  operation: text("operation").notNull(),
  modelVersion: text("model_version"),
  units: integer("units").notNull().default(1),
  /** TRY milyonda bir. */
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  cacheHit: boolean("cache_hit").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Her kosu buraya yazilir. Sessiz basarisizlik kabul edilmez. */
export const ingestRun = pgTable("ingest_run", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  merchantId: bigint("merchant_id", { mode: "number" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status")
    .$type<"running" | "success" | "partial" | "failed">()
    .notNull()
    .default("running"),
  offersSeen: integer("offers_seen").notNull().default(0),
  offersCreated: integer("offers_created").notNull().default(0),
  offersUpdated: integer("offers_updated").notNull().default(0),
  pricePointsWritten: integer("price_points_written").notNull().default(0),
  errorText: text("error_text"),
});
