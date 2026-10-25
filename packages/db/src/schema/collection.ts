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
  date,
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
  /** 0075: NULL = ayda kosu sayisi sinirsiz. */
  maxRunsPerMonth: smallint("max_runs_per_month"),
  runWindowDays: smallint("run_window_days").notNull(),
  initialMaxRequests: integer("initial_max_requests").notNull(),
  refreshMaxRequests: integer("refresh_max_requests").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  initialLoadExempt: boolean("initial_load_exempt").notNull().default(false),
  permissionBasis: text("permission_basis").$type<CollectionPermissionBasis>().notNull(),
  permissionNote: text("permission_note"),
  // 0073 (karar 0120): guvenlik sinirlari.
  initialRunWindowDays: smallint("initial_run_window_days"),
  minRequestIntervalMs: integer("min_request_interval_ms").notNull().default(2000),
  initialMaxBytes: bigint("initial_max_bytes", { mode: "number" }).notNull(),
  refreshMaxBytes: bigint("refresh_max_bytes", { mode: "number" }).notNull(),
  blockedCooldownMinutes: integer("blocked_cooldown_minutes").notNull().default(60),
  // 0075 (karar 0124): hacim kotasi. NULL = o kota uygulanmaz.
  dailyMaxRequests: integer("daily_max_requests"),
  monthlyMaxRequests: integer("monthly_max_requests"),
  monthlyMaxProducts: integer("monthly_max_products"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 0075 (karar 0124): UTC gun bazli rezerve istek ve islenen urun sayaci. Yalniz
 * `collection_run_usage_guard` tetikleyicisi yazar; uygulama rolu SELECT yapar.
 */
export const collectionUsageDay = pgTable(
  "collection_usage_day",
  {
    source: text("source").notNull(),
    usageDate: date("usage_date", { mode: "string" }).notNull(),
    requests: bigint("requests", { mode: "number" }).notNull().default(0),
    products: bigint("products", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.source, t.usageDate] })],
);

export type TransferOrigin = "unknown" | "vps" | "admin_wifi" | "admin_wired" | "admin_mobile";

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
  // 0073 (karar 0120): bayt muhasebesi, indirme onayi, aktarim kaynagi. max_bytes tetikleyiciyle yazilir.
  maxBytes: bigint("max_bytes", { mode: "number" }).notNull().default(0),
  bytesDownloaded: bigint("bytes_downloaded", { mode: "number" }).notNull().default(0),
  downloadApprovedBytes: bigint("download_approved_bytes", { mode: "number" }).notNull().default(0),
  downloadApprovedBy: bigint("download_approved_by", { mode: "number" }),
  downloadApprovedAt: timestamp("download_approved_at", { withTimezone: true }),
  transferOrigin: text("transfer_origin").$type<TransferOrigin>().notNull().default("unknown"),
  // 0075 (karar 0124): HTTP isteginden ONCE rezerve edilen istek (azalmaz) ve kota defterine yazilan urun.
  requestsReserved: integer("requests_reserved").notNull().default(0),
  productsCounted: bigint("products_counted", { mode: "number" }).notNull().default(0),
});

export type CollectionUnitStatus = "pending" | "done" | "empty" | "failed" | "blocked";
/** 0073: 'sitemap_file' (sitemap dosyasi), 'listing_page' (liste sayfasi); Trendyol (0118) ayni kumeyi kullanir. */
export type CollectionUnitKind = "query" | "product_page" | "listing_page" | "sitemap_file";

/**
 * Kesif birimi: bir kaynak istegi. Hepsiburada: (sorgu, sayfa); Trendyol (0118): acilan
 * urun sayfasi (unit_key = contentId) ya da liste sayfasi (unit_key = yol). Kapsam raporunun kaynagi.
 */
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
    // 'pending' birim henuz istenmedi (0073): fetched_at bos olabilir.
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    unitSeq: integer("unit_seq"),
    attempts: smallint("attempts").notNull().default(0),
    bytesReceived: bigint("bytes_received", { mode: "number" }).notNull().default(0),
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
  // 0079 (karar 0118): Trendyol alanlari; Hepsiburada yazmaz.
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

export type DiscoveryPriceState =
  | "unpriced"
  | "listing_price"
  | "page_verified"
  | "stale"
  | "unavailable";

/** 0092 (karar 0140): kaldırılma takibi durumu. */
export type DiscoveryPresence = "present" | "missing" | "removed";

/**
 * 0073 (karar 0120): fiyatsiz urun kesif defteri. offer DEGILDIR; FIYAT KOLONU YOKTUR.
 * Birincil anahtar (source, external_id): tekrar kesif yeni satir uretmez.
 */
export const catalogDiscovery = pgTable(
  "catalog_discovery",
  {
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    codeKind: text("code_kind").$type<"pm" | "p">().notNull(),
    url: text("url").notNull(),
    title: text("title"),
    imageUrl: text("image_url"),
    sourceUnitKey: text("source_unit_key").notNull(),
    firstSeenRunId: bigint("first_seen_run_id", { mode: "number" }).notNull(),
    lastSeenRunId: bigint("last_seen_run_id", { mode: "number" }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    priceState: text("price_state").$type<DiscoveryPriceState>().notNull().default("unpriced"),
    priceCheckedAt: timestamp("price_checked_at", { withTimezone: true }),
    // 0092 (karar 0140): kaldırılma takibi. Yalnızca tam ve doğrulanmış taramalar sayar.
    presence: text("presence").$type<DiscoveryPresence>().notNull().default("present"),
    missedScans: integer("missed_scans").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.source, t.externalId] })],
);

/** 0092 (karar 0140): kaynak başına son finalize edilmiş tam tarama. */
export const catalogDiscoveryScanState = pgTable("catalog_discovery_scan_state", {
  source: text("source").primaryKey(),
  lastFinalizedRunId: bigint("last_finalized_run_id", { mode: "number" }).notNull(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull().defaultNow(),
});
