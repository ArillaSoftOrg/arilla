/** 0006_creator.sql karsiligi. */
import {
  bigint,
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const creator = pgTable("creator", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  /** /@elif */
  handle: text("handle").notNull(),
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  avatarUrl: text("avatar_url"),
  tier: text("tier").$type<"starter" | "rising" | "trusted" | "top">().notNull().default("starter"),
  affiliateMode: text("affiliate_mode").$type<"own" | "platform">().notNull().default("own"),
  isVerified: boolean("is_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Creator'in kendi affiliate hesaplari (Model A). Komisyon dogrudan ona gider. */
export const creatorAffiliateAccount = pgTable("creator_affiliate_account", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  creatorId: bigint("creator_id", { mode: "number" }).notNull(),
  merchantId: bigint("merchant_id", { mode: "number" }).notNull(),
  trackingId: text("tracking_id").notNull(),
  status: text("status").$type<"active" | "invalid" | "revoked">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const collection = pgTable("collection", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  creatorId: bigint("creator_id", { mode: "number" }).notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  coverUrl: text("cover_url"),
  isPublic: boolean("is_public").notNull().default(true),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const collectionItem = pgTable("collection_item", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  collectionId: bigint("collection_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  preferredOfferId: bigint("preferred_offer_id", { mode: "number" }),
  note: text("note"),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const follow = pgTable(
  "follow",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
    creatorId: bigint("creator_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.creatorId] })],
);

export const savedItem = pgTable("saved_item", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  /** wishlist attribution */
  sourceCreatorId: bigint("source_creator_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Fiyat, stok ve beden alarmlari tek tabloda. Hepsi e-posta ile gider. */
export const alert = pgTable("alert", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  kind: text("kind").$type<"price_drop" | "any_drop" | "restock" | "size_restock">().notNull(),
  targetPrice: bigint("target_price", { mode: "number" }),
  sizeNorm: text("size_norm"),
  isActive: boolean("is_active").notNull().default(true),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
