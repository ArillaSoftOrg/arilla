/**
 * 0096_external_category_reference.sql karsiligi (karar 0143): dis kaynak (Trendyol) kategori
 * referans agaci. ManiCepte `category` agacindan ayridir; `external_id` dahili `category.id`
 * ile karismaz. Kisitlar ve indeksler burada TEKRARLANMAZ; tek sahibi migration'dir.
 */
import {
  bigint,
  boolean,
  integer,
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
  rootCount: integer("root_count").notNull(),
  maxDepth: smallint("max_depth").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const externalCategory = pgTable(
  "external_category",
  {
    source: text("source").notNull(),
    externalId: bigint("external_id", { mode: "number" }).notNull(),
    parentExternalId: bigint("parent_external_id", { mode: "number" }),
    name: text("name").notNull(),
    depth: smallint("depth").notNull(),
    isLeaf: boolean("is_leaf").notNull(),
    pathIds: bigint("path_ids", { mode: "number" }).array().notNull(),
    pathText: text("path_text").notNull(),
    importId: bigint("import_id", { mode: "number" }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
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
