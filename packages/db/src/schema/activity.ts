/**
 * 0036_user_activity.sql karsiligi (docs/decisions/0049): giris/cikis
 * gecmisi, rizali davranissal analitik olaylari ve kullanici ozeti.
 * Kisitlar (CHECK, kismi UNIQUE, yetki daraltmasi) migration'dadir; burada
 * yalnizca kolonlar tanimlanir.
 *
 * Bu tablolarda IP, ham user agent, token, istek basligi/govdesi ve serbest
 * JSON alani YOKTUR.
 */
import { bigint, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { BrowserFamily, DeviceClass } from "./auth.ts";

export type AuthEventKind = "sign_up" | "sign_in" | "sign_out" | "session_revoked";
/** `email` = e-posta bağlantısı; diğerleri `user_identity.provider` ile aynı. */
export type AuthEventProvider = "email" | "google" | "apple" | "phone";

/** Güvenlik sınıfı (rıza gerektirmez). Append-only: UPDATE yetkisi yok. */
export const authEvent = pgTable("auth_event", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  kind: text("kind").$type<AuthEventKind>().notNull(),
  provider: text("provider").$type<AuthEventProvider>(),
  sessionId: uuid("session_id"),
  deviceClass: text("device_class").$type<DeviceClass>(),
  browserFamily: text("browser_family").$type<BrowserFamily>(),
  countryCode: text("country_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ActivityEventKind = "search_submitted" | "product_viewed" | "merchant_exit";
export type ActivityChannel = "web" | "mcp" | "extension" | "api";

/**
 * Davranışsal analitik. YALNIZCA analitik rızasıyla ve yalnızca
 * `packages/core/src/activity/record.ts` üzerinden yazılır.
 */
export const userActivityEvent = pgTable("user_activity_event", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  kind: text("kind").$type<ActivityEventKind>().notNull(),
  channel: text("channel").$type<ActivityChannel>().notNull().default("web"),
  productId: bigint("product_id", { mode: "number" }),
  offerId: bigint("offer_id", { mode: "number" }),
  clickId: uuid("click_id"),
  searchMode: text("search_mode").$type<"text">(),
  queryNorm: text("query_norm"),
  resultCount: integer("result_count"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** 0061: yeni yazıcıda zorunlu; sürüm 1 (eski) satırlarda NULL. (user_id, event_id) tekildir. */
  eventId: uuid("event_id"),
  /** 0061: 1 = eski biçim (event_id yok), 2 = event_id zorunlu. */
  schemaVersion: smallint("schema_version").notNull().default(1),
});

/** Kullanıcı başına tek satır. NULL sayaç = bilinmiyor (geçmiş uydurulmaz). */
export const userActivitySummary = pgTable("user_activity_summary", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  firstSignInAt: timestamp("first_sign_in_at", { withTimezone: true }),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  signInCount: integer("sign_in_count"),
  serviceCountersSince: timestamp("service_counters_since", { withTimezone: true }),
  lastDeviceClass: text("last_device_class").$type<DeviceClass>(),
  lastBrowserFamily: text("last_browser_family").$type<BrowserFamily>(),
  lastCountryCode: text("last_country_code"),
  searchCount: integer("search_count"),
  lastSearchAt: timestamp("last_search_at", { withTimezone: true }),
  productViewCount: integer("product_view_count"),
  merchantExitCount: integer("merchant_exit_count"),
  analyticsCountersSince: timestamp("analytics_counters_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
