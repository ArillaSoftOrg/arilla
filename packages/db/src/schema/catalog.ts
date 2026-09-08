/**
 * 0002_catalog.sql karsiligi.
 *
 * Indeksler ve CHECK kisitlari burada TEKRARLANMAZ: onlarin tek sahibi
 * migration dosyalaridir. Burada yalnizca tablo ve kolon tanimlari vardir;
 * CHECK'lerdeki deger kumeleri `$type<...>()` ile TS'e tasinir.
 */
import {
  bigint,
  boolean,
  char,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const merchant = pgTable("merchant", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  logoUrl: text("logo_url"),
  sourceType: text("source_type")
    .$type<"xml_feed" | "api" | "affiliate_network" | "user_discovered">()
    .notNull(),
  feedUrl: text("feed_url"),
  feedConfig: jsonb("feed_config").notNull().default({}),
  refreshMinutes: integer("refresh_minutes").notNull().default(360),
  affiliateNetwork: text("affiliate_network"),
  affiliateStatus: text("affiliate_status")
    .$type<"none" | "pending" | "active" | "suspended">()
    .notNull()
    .default("none"),
  commissionRateBp: integer("commission_rate_bp"),
  deeplinkTemplate: text("deeplink_template"),
  isActive: boolean("is_active").notNull().default(true),
  trustScore: smallint("trust_score").notNull().default(50),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const brand = pgTable("brand", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  nameNorm: text("name_norm").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const category = pgTable("category", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  parentId: bigint("parent_id", { mode: "number" }),
  path: text("path").notNull(),
  /** Kesfet akisina girebilir mi. Ic giyim, saglik, mahrem urunler FALSE. */
  isDiscoverable: boolean("is_discoverable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const product = pgTable("product", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  publicId: uuid("public_id").notNull().defaultRandom(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  brandId: bigint("brand_id", { mode: "number" }),
  categoryId: bigint("category_id", { mode: "number" }),
  gtin: text("gtin"),
  mpn: text("mpn"),
  modelKey: text("model_key"),
  color: text("color"),
  attributes: jsonb("attributes").notNull().default({}),
  primaryImageUrl: text("primary_image_url"),
  /** Denormalize; toplu isle guncellenir, istek yolu okur. Kurus cinsinden. */
  minPrice: bigint("min_price", { mode: "number" }),
  maxPrice: bigint("max_price", { mode: "number" }),
  offerCount: integer("offer_count").notNull().default(0),
  inStockCount: integer("in_stock_count").notNull().default(0),
  priceUpdatedAt: timestamp("price_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productSlugHistory = pgTable("product_slug_history", {
  slug: text("slug").primaryKey(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const offer = pgTable("offer", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  merchantId: bigint("merchant_id", { mode: "number" }).notNull(),
  /** NULLABLE. Kasitli: eslesmemis offer sistemde yasayabilir. */
  productId: bigint("product_id", { mode: "number" }),
  externalId: text("external_id").notNull(),
  url: text("url").notNull(),
  titleRaw: text("title_raw").notNull(),
  brandRaw: text("brand_raw"),
  categoryRaw: text("category_raw"),
  imageUrl: text("image_url"),
  imageHash: text("image_hash"),
  attributesRaw: jsonb("attributes_raw").notNull().default({}),
  currentPrice: bigint("current_price", { mode: "number" }),
  listPrice: bigint("list_price", { mode: "number" }),
  currency: char("currency", { length: 3 }).notNull().default("TRY"),
  inStock: boolean("in_stock").notNull().default(true),
  shippingDays: smallint("shipping_days"),
  shippingCost: bigint("shipping_cost", { mode: "number" }),
  freeShippingThreshold: bigint("free_shipping_threshold", { mode: "number" }),
  discoverySource: text("discovery_source")
    .$type<"feed" | "api" | "user_link">()
    .notNull()
    .default("feed"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

export const offerVariant = pgTable("offer_variant", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  externalId: text("external_id").notNull(),
  sizeLabel: text("size_label"),
  sizeNorm: text("size_norm"),
  inStock: boolean("in_stock").notNull().default(true),
  priceOverride: bigint("price_override", { mode: "number" }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * APPEND-ONLY. `arilla_app` rolunun bu tabloda UPDATE ve DELETE yetkisi yoktur
 * (migrations/0010). Yalnizca durum DEGISTIGINDE satir yazilir.
 */
export const variantStockEvent = pgTable("variant_stock_event", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  variantId: bigint("variant_id", { mode: "number" }).notNull(),
  inStock: boolean("in_stock").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});
