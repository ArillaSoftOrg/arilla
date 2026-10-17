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
  customType,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Drizzle'in yerlesik bytea'si yok; yalnizca 16 baytlik ozet icin kullanilir. */
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const merchant = pgTable("merchant", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  logoUrl: text("logo_url"),
  sourceType: text("source_type")
    .$type<"xml_feed" | "api" | "affiliate_network" | "user_discovered" | "shopify">()
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
  /** 0076 (karar 0127): yalnizca TRY disi teklifi olan farkli magaza sayisi. */
  foreignOfferCount: integer("foreign_offer_count").notNull().default(0),
  priceUpdatedAt: timestamp("price_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** 0074 (karar 0121): `published` disindaki urun kullaniciya kapali kaynak ilanidir. */
  publicationState: text("publication_state").notNull().default("published"),
  holdReason: text("hold_reason"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  sourceMerchantId: bigint("source_merchant_id", { mode: "number" }),
  sourceExternalId: text("source_external_id"),
  sourceOfferId: bigint("source_offer_id", { mode: "number" }),
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
  /** 0065 (karar 0111): pazaryeri saticisi; NULL = merchant'in kendisi satiyor. */
  sellerId: bigint("seller_id", { mode: "number" }),
  feedSourceId: bigint("feed_source_id", { mode: "number" }),
  /** Normalize alanlarin sha256'si; degismediyse satir yazilmaz. */
  fingerprint: text("fingerprint"),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
  lastSnapshotId: bigint("last_snapshot_id", { mode: "number" }),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  /** 0066 (karar 0112): kaynagin affiliate takip baglantisi; kanonik `url`'den ayri. */
  affiliateUrl: text("affiliate_url"),
  deactivationReason: text("deactivation_reason").$type<
    "missing_from_snapshot" | "source_removed" | "admin" | "expired"
  >(),
});

/**
 * 0053 (karar 0073): offer'in kaynak gorselleri. `sourcePosition` magazanin
 * sirasi, `displayRank` bizim gosterim siramiz (NULL = saklanir, gosterilmez).
 * Binary yok; `r2Url` ileride aynalama isi tarafindan doldurulur.
 */
export const offerImage = pgTable("offer_image", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  /** md5(normalize URL), 16 bayt. */
  urlHash: bytea("url_hash").notNull(),
  sourceUrl: text("source_url").notNull(),
  r2Url: text("r2_url"),
  sourcePosition: smallint("source_position").notNull(),
  displayRank: smallint("display_rank"),
  isVariantSpecific: boolean("is_variant_specific").notNull().default(false),
  imageHash: text("image_hash"),
  perceptualHash: bigint("perceptual_hash", { mode: "bigint" }),
  width: integer("width"),
  height: integer("height"),
  status: text("status").$type<"active" | "removed" | "broken">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const offerVariant = pgTable("offer_variant", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  offerId: bigint("offer_id", { mode: "number" }).notNull(),
  externalId: text("external_id").notNull(),
  sizeLabel: text("size_label"),
  sizeNorm: text("size_norm"),
  inStock: boolean("in_stock").notNull().default(true),
  priceOverride: bigint("price_override", { mode: "number" }),
  sku: text("sku"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** 0022: bu ticari varyantin GS1 dogrulanmis barkodu (docs/decisions/0036). */
  gtin: text("gtin"),
  /** 'feed' | 'products_js' | 'sku' */
  gtinSource: text("gtin_source"),
  /** 0065: ayni ticari varyantin saticilar arasi ortak kaydi. */
  canonicalVariantId: bigint("canonical_variant_id", { mode: "number" }),
  /** 0065: normalize varyant eksenleri, or. {"beden":"42","renk":"siyah"}. */
  optionValues: jsonb("option_values").$type<Record<string, string>>().notNull().default({}),
});

/** 0065 (karar 0111): pazaryerindeki magaza. Kimlik (merchant_id, external_id). */
export const seller = pgTable("seller", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  merchantId: bigint("merchant_id", { mode: "number" }).notNull(),
  externalId: text("external_id").notNull(),
  name: text("name"),
  url: text("url"),
  isActive: boolean("is_active").notNull().default(true),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 0065: urunun ticari varyanti (beden/kapasite/hacim). `optionKey` normalize,
 * sirali "eksen=deger" listesi; tek varyantli urunde ''.
 */
export const canonicalVariant = pgTable("canonical_variant", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  optionKey: text("option_key").notNull(),
  options: jsonb("options").$type<Record<string, string>>().notNull().default({}),
  /** GS1 dogrulanmis, 14 haneli. */
  gtin: text("gtin"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/**
 * APPEND-ONLY (0026, docs/decisions/0037): varyantin etkin fiyati yalnizca
 * DEGISTIGINDE (ve ilk gorulmede) yazilir. Cok boyutlu tekliflerde boyut
 * bazli fiyat gecmisinin tek kaynagi.
 */
export const variantPriceEvent = pgTable("variant_price_event", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  variantId: bigint("variant_id", { mode: "number" }).notNull(),
  price: bigint("price", { mode: "number" }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});
