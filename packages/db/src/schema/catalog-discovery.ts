/**
 * 0074_catalog_discovery.sql karsiligi (karar 0120): sitemap ile urun kesfi.
 *
 * Kesif defteri (`catalog_discovery`) offer DEGILDIR ve fiyat kolonu yoktur.
 * Tetikleyiciler, CHECK kisitlari ve yetkiler burada TEKRARLANMAZ; tek sahibi
 * migration'dir.
 */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Kaynak basina kesif butceleri. Uygulama rolu YALNIZCA okur. */
export const discoverySourcePolicy = pgTable("discovery_source_policy", {
  source: text("source").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  indexUrl: text("index_url").notNull(),
  filePathPattern: text("file_path_pattern").notNull(),
  urlHost: text("url_host").notNull(),
  imageHost: text("image_host").notNull(),
  minRequestIntervalMs: integer("min_request_interval_ms").notNull(),
  dailyMaxRequests: integer("daily_max_requests").notNull(),
  initialMaxRequests: integer("initial_max_requests").notNull(),
  initialMaxBytes: bigint("initial_max_bytes", { mode: "number" }).notNull(),
  refreshMaxRequests: integer("refresh_max_requests").notNull(),
  refreshMaxBytes: bigint("refresh_max_bytes", { mode: "number" }).notNull(),
  maxAttemptsPerFile: smallint("max_attempts_per_file").notNull(),
  blockedCooldownHours: smallint("blocked_cooldown_hours").notNull(),
  removalMissedScans: smallint("removal_missed_scans").notNull(),
  targetUniqueItems: bigint("target_unique_items", { mode: "number" }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SyncOperationKind = "initial_import" | "weekly_refresh";
export type SyncOperationStatus =
  | "open"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled"
  | "expired";
export type RemovalState = "not_applicable" | "pending" | "done" | "skipped_partial";

/** Ilk aktarim / haftalik yenileme operasyonu. Butce ve sure tetikleyiciyle yazilir. */
export const catalogSyncOperation = pgTable("catalog_sync_operation", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  source: text("source").notNull(),
  kind: text("kind").$type<SyncOperationKind>().notNull(),
  status: text("status").$type<SyncOperationStatus>().notNull().default("open"),
  quotaRunId: bigint("quota_run_id", { mode: "number" }),
  startedBy: bigint("started_by", { mode: "number" }),
  networkDeclared: text("network_declared").$type<"wifi" | "wired">().notNull(),
  maxRequests: integer("max_requests").notNull(),
  maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
  requestsMade: integer("requests_made").notNull().default(0),
  bytesDecoded: bigint("bytes_decoded", { mode: "number" }).notNull().default(0),
  bytesTransferred: bigint("bytes_transferred", { mode: "number" }).notNull().default(0),
  filesPlanned: integer("files_planned").notNull().default(0),
  indexPlannedAt: timestamp("index_planned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastRequestAt: timestamp("last_request_at", { withTimezone: true }),
  lastCheckpointAt: timestamp("last_checkpoint_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  leaseClient: text("lease_client"),
  leaseHeartbeatAt: timestamp("lease_heartbeat_at", { withTimezone: true }),
  removalState: text("removal_state").$type<RemovalState>().notNull().default("not_applicable"),
  lastErrorCode: text("last_error_code"),
  lastErrorDetail: text("last_error_detail"),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
});

export type SyncUnitStatus = "pending" | "fetching" | "done" | "failed" | "blocked";

/** Dosya birimi: seq 0 = indeks, 1..N = sitemap dosyalari. Dosya bazinda checkpoint. */
export const catalogSyncUnit = pgTable(
  "catalog_sync_unit",
  {
    operationId: bigint("operation_id", { mode: "number" }).notNull(),
    seq: integer("seq").notNull(),
    unitKind: text("unit_kind").$type<"index" | "file">().notNull(),
    fileUrl: text("file_url").notNull(),
    sourceLastmod: timestamp("source_lastmod", { withTimezone: true }),
    status: text("status").$type<SyncUnitStatus>().notNull().default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    itemsFound: integer("items_found").notNull().default(0),
    itemsValid: integer("items_valid").notNull().default(0),
    itemsNew: integer("items_new").notNull().default(0),
    bytesDecoded: bigint("bytes_decoded", { mode: "number" }).notNull().default(0),
    bytesTransferred: bigint("bytes_transferred", { mode: "number" }).notNull().default(0),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.seq] })],
);

/** Append-only istek defteri: gunluk tavan ve istek araligi buradan hesaplanir. */
export const catalogSyncRequest = pgTable("catalog_sync_request", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  source: text("source").notNull(),
  operationId: bigint("operation_id", { mode: "number" }).notNull(),
  seq: integer("seq").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DiscoveryPriceState = "unpriced" | "verified" | "stale" | "unavailable";
export type DiscoveryPresence = "present" | "missing" | "removed";
export type DiscoveryPublishState = "hidden" | "published" | "withdrawn";

/** Fiyatsiz urun kesif defteri. Birincil anahtar (source, external_id). */
export const catalogDiscovery = pgTable(
  "catalog_discovery",
  {
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    codeKind: text("code_kind").$type<"pm" | "p">().notNull(),
    urlPath: text("url_path").notNull(),
    title: text("title"),
    imageUrl: text("image_url"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    firstSeenOperationId: bigint("first_seen_operation_id", { mode: "number" }).notNull(),
    lastSeenOperationId: bigint("last_seen_operation_id", { mode: "number" }).notNull(),
    lastSeenUnitSeq: integer("last_seen_unit_seq").notNull(),
    missedScans: smallint("missed_scans").notNull().default(0),
    presence: text("presence").$type<DiscoveryPresence>().notNull().default("present"),
    priceState: text("price_state").$type<DiscoveryPriceState>().notNull().default("unpriced"),
    priceOfferId: bigint("price_offer_id", { mode: "number" }),
    priceSource: text("price_source"),
    priceCheckedAt: timestamp("price_checked_at", { withTimezone: true }),
    publishState: text("publish_state").$type<DiscoveryPublishState>().notNull().default("hidden"),
    offerId: bigint("offer_id", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.source, t.externalId] })],
);

/** Panel sayaclari (count(*) istek yolunda calismaz). */
export const catalogDiscoveryTally = pgTable("catalog_discovery_tally", {
  source: text("source").primaryKey(),
  itemsTotal: bigint("items_total", { mode: "number" }).notNull().default(0),
  itemsPriced: bigint("items_priced", { mode: "number" }).notNull().default(0),
  itemsPublished: bigint("items_published", { mode: "number" }).notNull().default(0),
  itemsRemoved: bigint("items_removed", { mode: "number" }).notNull().default(0),
  recountedAt: timestamp("recounted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
