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
  // 0073 (karar 0120): guvenlik sinirlari.
  initialRunWindowDays: smallint("initial_run_window_days"),
  minRequestIntervalMs: integer("min_request_interval_ms").notNull().default(2000),
  initialMaxBytes: bigint("initial_max_bytes", { mode: "number" }).notNull(),
  refreshMaxBytes: bigint("refresh_max_bytes", { mode: "number" }).notNull(),
  blockedCooldownMinutes: integer("blocked_cooldown_minutes").notNull().default(60),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
});

export type CollectionUnitStatus = "pending" | "done" | "empty" | "failed" | "blocked";
/** 0073: 'sitemap_file' (sitemap dosyasi), 'listing_page' (liste sayfasi); 0072 ile birlesik kume. */
export type CollectionUnitKind = "query" | "product_page" | "listing_page" | "sitemap_file";

/** Kesif birimi: bir kaynak istegi = (sorgu, sayfa). Kapsam raporunun kaynagi. */
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

/** Dogrulanmis kaynak kayitlari; Python `hb-merge` offer modeline birlestirir. */
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
  },
  (t) => [primaryKey({ columns: [t.source, t.externalId] })],
);
