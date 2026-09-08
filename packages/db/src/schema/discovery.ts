/** 0009_discovery.sql karsiligi. */
import {
  bigint,
  boolean,
  date,
  inet,
  integer,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** KVKK: kisisel veridir. Acik riza gerekir, kullanici silebilmelidir. */
export const productView = pgTable("product_view", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }),
  sessionId: text("session_id").notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSizeProfile = pgTable("user_size_profile", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  /** 'ayakkabi', 'ust-giyim' */
  categoryPath: text("category_path").notNull(),
  sizeNorm: text("size_norm").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** KVKK riza kayitlari. Neye, ne zaman riza verildi. */
export const userConsent = pgTable("user_consent", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  kind: text("kind")
    .$type<"browsing_history" | "marketing_email" | "personalization" | "public_discovery">()
    .notNull(),
  granted: boolean("granted").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  ip: inet("ip"),
});

export const trendSnapshot = pgTable("trend_snapshot", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  coverUrl: text("cover_url"),
  categoryPath: text("category_path"),
  kind: text("kind").$type<"algorithmic" | "editorial">().notNull().default("algorithmic"),
  /** Sponsorlu icerik HER ZAMAN etiketlenir. Veritabani kisiti bunu zorunlu tutar. */
  isSponsored: boolean("is_sponsored").notNull().default(false),
  sponsorMerchantId: bigint("sponsor_merchant_id", { mode: "number" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  productIds: bigint("product_ids", { mode: "number" }).array().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  isPublished: boolean("is_published").notNull().default(false),
});

/**
 * Kesfet akisi. `source` ayrimi arayuzde korunur: secilmis icerik ASLA
 * kullanici kesfi gibi etiketlenmez.
 */
export const publicFind = pgTable("public_find", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  source: text("source").$type<"curated" | "organic">().notNull().default("organic"),
  /** curated icin NULL. */
  distinctFinderCount: integer("distinct_finder_count"),
  /** 'bu hafta'. curated icin NULL. */
  foundLabel: text("found_label"),
  /** Gun hassasiyeti, saat degil. */
  firstFoundAt: date("first_found_at"),
  rankScore: real("rank_score").notNull().default(0),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Gunluk rotasyon YALNIZCA /kesfet icindir. Trend sayfalari gunluk degismez. */
export const discoverySlot = pgTable(
  "discovery_slot",
  {
    slotDate: date("slot_date").notNull(),
    position: smallint("position").notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    source: text("source").$type<"curated" | "organic">().notNull(),
  },
  (table) => [primaryKey({ columns: [table.slotDate, table.position] })],
);
