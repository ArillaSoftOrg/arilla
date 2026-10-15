/**
 * 0070_catalog_collection.sql karsiligi (karar 0117): yonetici tarayicisindan
 * katalog toplama kosulari, kota politikasi, kapsam birimleri ve ara depo.
 *
 * Kota tetikleyicileri, indeksler ve CHECK kisitlari burada TEKRARLANMAZ; tek
 * sahibi migration'dir.
 */
import {
  bigint,
  boolean,
  char,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type CollectionPermissionBasis =
  | "verbal_reported"
  | "written_email_reported"
  | "declared_extended"
  | "written_agreement"
  | "public_feed";

/** Kaynak basina kota ve izin politikasi. Uygulama rolu YALNIZCA okur. */
export const collectionSource = pgTable("collection_source", {
  source: text("source").primaryKey(),
  merchantSlug: text("merchant_slug").notNull(),
  minIntervalDays: smallint("min_interval_days").notNull(),
  maxRunsPerMonth: smallint("max_runs_per_month").notNull(),
  runWindowDays: smallint("run_window_days").notNull(),
  initialMaxRequests: integer("initial_max_requests").notNull(),
  refreshMaxRequests: integer("refresh_max_requests").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  initialLoadExempt: boolean("initial_load_exempt").notNull().default(false),
  permissionBasis: text("permission_basis").$type<CollectionPermissionBasis>().notNull(),
  permissionNote: text("permission_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CollectionRunStatus = "open" | "completed" | "aborted" | "released";

/** Kota defteri: her satir bir toplama kosusu. `reserved_at`/`expires_at` tetikleyiciyle yazilir. */
export const collectionRun = pgTable("collection_run", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  source: text("source").notNull(),
  startedBy: bigint("started_by", { mode: "number" }),
  kind: text("kind").$type<"initial" | "refresh">().notNull().default("initial"),
  status: text("status").$type<CollectionRunStatus>().notNull().default("open"),
  reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  requestsMade: integer("requests_made").notNull().default(0),
  maxRequests: integer("max_requests").notNull(),
  options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
  checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>(),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
});

export type CollectionUnitStatus = "done" | "empty" | "failed" | "blocked";

/**
 * Kesif birimi: bir kaynak istegi. Hepsiburada: (sorgu, sayfa); Trendyol (0072): acilan
 * urun sayfasi (unit_key = contentId) ya da liste sayfasi (unit_key = yol). Kapsam raporunun kaynagi.
 */
export type CollectionUnitKind = "query" | "product_page" | "listing_page";
export const collectionUnit = pgTable(
  "collection_unit",
  {
    runId: bigint("run_id", { mode: "number" }).notNull(),
    kind: text("kind").$type<CollectionUnitKind>().notNull(),
    unitKey: text("unit_key").notNull(),
    page: smallint("page").notNull().default(1),
    status: text("status").$type<CollectionUnitStatus>().notNull(),
    itemsFound: integer("items_found").notNull().default(0),
    itemsNew: integer("items_new").notNull().default(0),
    totalHint: integer("total_hint"),
    errorCode: text("error_code"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.kind, t.unitKey, t.page] })],
);

/** Dogrulanmis kaynak kayitlari; Python `collect-merge` offer modeline birlestirir. */
export const catalogIntakeRecord = pgTable("catalog_intake_record", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  runId: bigint("run_id", { mode: "number" }).notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
  listPriceMinor: bigint("list_price_minor", { mode: "number" }),
  currency: char("currency", { length: 3 }).notNull(),
  inStock: boolean("in_stock"),
  imageUrl: text("image_url"),
  brand: text("brand"),
  categoryRaw: text("category_raw"),
  sellerExternalId: text("seller_external_id"),
  sellerName: text("seller_name"),
  variantLabel: text("variant_label"),
  gtin: text("gtin"),
  foundVia: text("found_via"),
  // 0072 (karar 0118): Trendyol alanlari; Hepsiburada yazmaz.
  imageUrls: jsonb("image_urls").$type<string[]>(),
  groupExternalId: text("group_external_id"),
  variantExternalId: text("variant_external_id"),
  /** Sepette uygulanan KOSULLU fiyat; satis fiyati degildir (price_minor'a girmez). */
  basketPriceMinor: bigint("basket_price_minor", { mode: "number" }),
  sourcePage: text("source_page").$type<"search_page" | "product_page" | "listing_page">(),
  sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
});
