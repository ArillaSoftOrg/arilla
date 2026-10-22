/**
 * 0096_external_category_reference.sql + 0098 (karar 0143, 0144) karsiligi: dis kaynak (Trendyol) kategori
 * referans agaci. ManiCepte `category` agacindan ayridir; `external_id` dahili `category.id`
 * ile karismaz. Kisitlar ve indeksler burada TEKRARLANMAZ; tek sahibi migration'dir.
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

export const externalCategoryImport = pgTable("external_category_import", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  source: text("source").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  categoryCount: integer("category_count").notNull(),
  /** 0098: hiyerarsisi bilinmeyen kaynakta (Hepsiburada sitemap) NULL. */
  rootCount: integer("root_count"),
  maxDepth: smallint("max_depth"),
  /** 0098 (karar 0144): kaynagin turu. */
  sourceKind: text("source_kind").$type<"api" | "sitemap">().notNull().default("api"),
  suspectCount: integer("suspect_count").notNull().default(0),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const externalCategory = pgTable(
  "external_category",
  {
    source: text("source").notNull(),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    parentExternalId: bigint("parent_external_id", { mode: "number" }),
    name: text("name").notNull(),
    /** 0098: `hierarchy_status = 'unknown'` iken depth/isLeaf/pathIds/pathText NULL. */
    depth: smallint("depth"),
    isLeaf: boolean("is_leaf"),
    pathIds: bigint("path_ids", { mode: "number" }).array(),
    pathText: text("path_text"),
    importId: bigint("import_id", { mode: "number" }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /** 0098 (karar 0144). */
    hierarchyStatus: text("hierarchy_status")
      .$type<"verified" | "unknown">()
      .notNull()
      .default("verified"),
    nameBasis: text("name_basis").$type<"source" | "slug">().notNull().default("source"),
    /** `suspect`: eslestirilemez, siniflandirmada kullanilmaz. */
    quality: text("quality").$type<"valid" | "suspect">().notNull().default("valid"),
    qualityReason: text("quality_reason"),
    slug: text("slug"),
    sourceUrl: text("source_url"),
    sourceAttrs: jsonb("source_attrs").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.source, table.externalId] })],
);

/** Bos acilir; siniflandirici okumaz. */
export const externalCategoryMap = pgTable(
  "external_category_map",
  {
    source: text("source").notNull(),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    categoryId: bigint("category_id", { mode: "number" }).notNull(),
    status: text("status")
      .$type<"suggested" | "confirmed" | "rejected">()
      .notNull()
      .default("suggested"),
    decidedBy: text("decided_by"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.source, table.externalId] })],
);
