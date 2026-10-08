/** 0056_trend_collections.sql karsiligi (docs/decisions/0077). */
import {
  bigint,
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type TrendCategory = "moda" | "guzellik" | "ev-yasam" | "ogrenci" | "genel";
export type TrendStatus = "draft" | "published" | "archived";
export type TrendType = "evergreen" | "seasonal" | "campaign";

/**
 * Editoryal urun kesfi koleksiyonu. Blog degil: baslik, tek cumle aciklama ve
 * urun izgarasi. `trend_snapshot` (donemlik/algoritmik) ile karistirilmaz.
 */
export const trend = pgTable("trend", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").$type<TrendCategory>().notNull(),
  /** Ayri editoryal gorsel yoksa NULL; okuma temsilci urun gorseline duser. */
  heroImageUrl: text("hero_image_url"),
  status: text("status").$type<TrendStatus>().notNull().default("draft"),
  featured: boolean("featured").notNull().default(false),
  trendType: text("trend_type").$type<TrendType>().notNull().default("evergreen"),
  sortOrder: integer("sort_order").notNull().default(0),
  activeFrom: timestamp("active_from", { withTimezone: true }),
  activeUntil: timestamp("active_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Trend-urun bagi; `sort_order` trend icindeki sira (0 = en iyi eslesme). */
export const trendProduct = pgTable(
  "trend_product",
  {
    trendId: bigint("trend_id", { mode: "number" }).notNull(),
    productId: bigint("product_id", { mode: "number" }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.trendId, table.productId] })],
);
