/**
 * 0065_catalog_feed_model.sql karsiligi (karar 0111): besleme kaynagi, surum,
 * parca kontrol noktasi, hata kayitlari, urun kimligi, eslestirme kararlari,
 * kategori esleme ve arama indeksi olaylari.
 *
 * Indeksler ve CHECK kisitlari burada TEKRARLANMAZ; tek sahibi migration'dir.
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

export type FeedSourceStatus = "discovered" | "active" | "paused" | "disabled" | "gone";

/**
 * Bir agin (ya da dogrudan magazanin) tek beslemesi. Kesifle otomatik kaydedilir
 * ama `discovered` kalir; merchant'a baglanip etkinlestirilmeden senkronize edilmez.
 * Kimlik bilgisi tutulmaz: `sourceUrlRedacted` yalnizca gosterim icindir.
 */
export const feedSource = pgTable("feed_source", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  network: text("network").notNull(),
  externalId: text("external_id").notNull(),
  merchantId: bigint("merchant_id", { mode: "number" }),
  programExternalId: text("program_external_id"),
  programName: text("program_name"),
  name: text("name"),
  format: text("format").$type<"xml" | "csv" | "json" | "ndjson">(),
  compression: text("compression").$type<"none" | "gzip" | "zip">(),
  sourceUrlRedacted: text("source_url_redacted"),
  status: text("status").$type<FeedSourceStatus>().notNull().default("discovered"),
  syncMode: text("sync_mode").$type<"snapshot" | "delta">().notNull().default("snapshot"),
  syncCursor: jsonb("sync_cursor").$type<Record<string, unknown>>(),
  market: char("market", { length: 2 }),
  currency: char("currency", { length: 3 }),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  schemaFingerprint: text("schema_fingerprint"),
  schemaFields: jsonb("schema_fields").$type<string[]>(),
  schemaChangedAt: timestamp("schema_changed_at", { withTimezone: true }),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  lastDiscoveryAt: timestamp("last_discovery_at", { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SnapshotStatus =
  | "downloading"
  | "downloaded"
  | "processing"
  | "complete"
  | "duplicate"
  | "rejected"
  | "failed";

/** Indirilen dosyanin surumu; ayni icerik (sha256) ikinci kez tamamlanmaz. */
export const sourceSnapshot = pgTable("source_snapshot", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  feedSourceId: bigint("feed_source_id", { mode: "number" }).notNull(),
  kind: text("kind").$type<"full" | "delta">().notNull().default("full"),
  status: text("status").$type<SnapshotStatus>().notNull().default("downloading"),
  sha256: text("sha256"),
  bytes: bigint("bytes", { mode: "number" }),
  recordCount: integer("record_count"),
  rejectedCount: integer("rejected_count").notNull().default(0),
  schemaFingerprint: text("schema_fingerprint"),
  storageKey: text("storage_key"),
  rejectReason: text("reject_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/** Snapshot parcasi; birlestirme ile `merged` ayni islemde yazilir. */
export const ingestChunk = pgTable("ingest_chunk", {
  snapshotId: bigint("snapshot_id", { mode: "number" }).notNull(),
  seq: integer("seq").notNull(),
  recordStart: bigint("record_start", { mode: "number" }).notNull(),
  recordCount: integer("record_count").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status").$type<"pending" | "merged" | "failed">().notNull().default("pending"),
  attempts: smallint("attempts").notNull().default(0),
  lastError: text("last_error"),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
});

/** Kayit duzeyi hata (dead-letter). Kosuyu durdurmaz. */
export const ingestError = pgTable("ingest_error", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  feedSourceId: bigint("feed_source_id", { mode: "number" }),
  snapshotId: bigint("snapshot_id", { mode: "number" }),
  runId: bigint("run_id", { mode: "number" }),
  recordRef: text("record_ref"),
  externalId: text("external_id"),
  errorCode: text("error_code").notNull(),
  detail: text("detail"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  status: text("status")
    .$type<"open" | "retrying" | "resolved" | "ignored">()
    .notNull()
    .default("open"),
  attempts: smallint("attempts").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export type IdentityKind = "gtin" | "mpn" | "model_hint";

/**
 * Tanimlayici -> hedef duzey: gtin -> canonical_variant, mpn (+marka) -> product,
 * model_hint yalnizca aday uretir (benzersiz degil, otomatik birlestirmez).
 */
export const productIdentity = pgTable("product_identity", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  kind: text("kind").$type<IdentityKind>().notNull(),
  valueNorm: text("value_norm").notNull(),
  brandId: bigint("brand_id", { mode: "number" }),
  targetLevel: text("target_level").$type<"variant" | "product">().notNull(),
  canonicalVariantId: bigint("canonical_variant_id", { mode: "number" }),
  productId: bigint("product_id", { mode: "number" }),
  status: text("status")
    .$type<"active" | "conflict" | "restricted" | "retired">()
    .notNull()
    .default("active"),
  sourceCount: integer("source_count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** APPEND-ONLY: kaynak kaydinda gorulen tanimlayici (kanit). */
export const identityObservation = pgTable("identity_observation", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  offerVariantId: bigint("offer_variant_id", { mode: "number" }),
  kind: text("kind").$type<IdentityKind>().notNull(),
  valueRaw: text("value_raw").notNull(),
  valueNorm: text("value_norm"),
  isValid: boolean("is_valid").notNull(),
  snapshotId: bigint("snapshot_id", { mode: "number" }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** APPEND-ONLY: offer <-> product baglama/ayirma kararlari. */
export const matchDecisionLog = pgTable("match_decision_log", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }),
  previousProductId: bigint("previous_product_id", { mode: "number" }),
  decision: text("decision").$type<"link" | "unlink" | "reject" | "hold">().notNull(),
  actor: text("actor").$type<"resolver" | "admin" | "backfill">().notNull(),
  actorUserId: bigint("actor_user_id", { mode: "number" }),
  basis: text("basis").notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Kaynak kategori yolu -> bizim kategorimiz. */
export const categorySourceMap = pgTable("category_source_map", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  merchantId: bigint("merchant_id", { mode: "number" }).notNull(),
  sourcePath: text("source_path").notNull(),
  pathNorm: text("path_norm").notNull(),
  categoryId: bigint("category_id", { mode: "number" }),
  status: text("status")
    .$type<"unmapped" | "suggested" | "confirmed" | "rejected">()
    .notNull()
    .default("unmapped"),
  offerCount: integer("offer_count").notNull().default(0),
  /** 0088 (karar 0133): kural onerisinin guveni ve surumu; onay/ret yoneticinindir. */
  confidence: smallint("confidence"),
  ruleVersion: smallint("rule_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 0088 (karar 0133): urun basina marka/kategori siniflandirma kaniti. */
export const productClassification = pgTable("product_classification", {
  productId: bigint("product_id", { mode: "number" }).primaryKey(),
  ruleVersion: smallint("rule_version").notNull(),
  state: text("state").$type<"applied" | "review" | "error">().notNull(),
  brandId: bigint("brand_id", { mode: "number" }),
  brandBasis: text("brand_basis")
    .$type<"existing" | "source" | "title" | "none" | "ambiguous">()
    .notNull(),
  categoryId: bigint("category_id", { mode: "number" }),
  categoryBasis: text("category_basis")
    .$type<
      "existing" | "source" | "source_title" | "title" | "none" | "conflict" | "low_confidence"
    >()
    .notNull(),
  confidence: smallint("confidence").notNull(),
  compatibleBrands: text("compatible_brands").array(),
  wroteBrand: boolean("wrote_brand").notNull().default(false),
  wroteCategory: boolean("wrote_category").notNull().default(false),
  detail: text("detail"),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 0088: siniflandirma kontrol noktasi (kural surumu + kapsam). */
export const productClassificationState = pgTable(
  "product_classification_state",
  {
    ruleVersion: smallint("rule_version").notNull(),
    scope: text("scope").notNull().default("all"),
    lastProductId: bigint("last_product_id", { mode: "number" }).notNull().default(0),
    scanned: bigint("scanned", { mode: "number" }).notNull().default(0),
    brandSet: bigint("brand_set", { mode: "number" }).notNull().default(0),
    categorySet: bigint("category_set", { mode: "number" }).notNull().default(0),
    review: bigint("review", { mode: "number" }).notNull().default(0),
    errors: bigint("errors", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.ruleVersion, t.scope] })],
);

/** 0103 (karar 0154): siniflandiricinin dinamik aday secimiyle yazabilecegi kategori dallari. */
export const classifierScope = pgTable("classifier_scope", {
  scopeCategoryId: bigint("scope_category_id", { mode: "number" }).primaryKey(),
  mode: text("mode").$type<"off" | "apply">().notNull().default("off"),
  decidedBy: text("decided_by").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Arama indeksi guncelleme olaylari (outbox). */
export const searchOutbox = pgTable("search_outbox", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  entity: text("entity").$type<"product" | "offer">().notNull(),
  entityId: bigint("entity_id", { mode: "number" }).notNull(),
  op: text("op").$type<"upsert" | "delete">().notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

/** 0066 (karar 0112): besleme x offer uyeligi; offer ancak hicbir etkin beslemede kalmayinca pasiflesir. */
export const feedSourceOffer = pgTable("feed_source_offer", {
  feedSourceId: bigint("feed_source_id", { mode: "number" }).notNull(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  lastSnapshotId: bigint("last_snapshot_id", { mode: "number" }).notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});
