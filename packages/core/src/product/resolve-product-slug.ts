/**
 * docs/routes.md: "Slug degisirse product_slug_history uzerinden 301
 * yonlendirilir. Hicbir URL olmez." Once guncel slug denenir, bulunamazsa
 * gecmis tablosunda aranir.
 */
import { brand, type Database, product, productSlugHistory } from "@arilla/db";
import { eq } from "drizzle-orm";
import type { ProductDetail, SlugResolution } from "./result-types.ts";

function toProductDetail(row: {
  id: number;
  publicId: string;
  slug: string;
  title: string;
  brandName: string | null;
  modelKey: string | null;
  color: string | null;
  primaryImageUrl: string | null;
  offerCount: number;
  inStockCount: number;
  priceUpdatedAt: Date | null;
}): ProductDetail {
  return {
    productId: row.id,
    publicId: row.publicId,
    slug: row.slug,
    title: row.title,
    brandName: row.brandName,
    modelKey: row.modelKey,
    color: row.color,
    primaryImageUrl: row.primaryImageUrl,
    offerCount: row.offerCount,
    inStockCount: row.inStockCount,
    priceUpdatedAt: row.priceUpdatedAt,
  };
}

async function findBySlug(db: Database, slug: string) {
  const rows = await db
    .select({
      id: product.id,
      publicId: product.publicId,
      slug: product.slug,
      title: product.title,
      brandName: brand.name,
      modelKey: product.modelKey,
      color: product.color,
      primaryImageUrl: product.primaryImageUrl,
      offerCount: product.offerCount,
      inStockCount: product.inStockCount,
      priceUpdatedAt: product.priceUpdatedAt,
    })
    .from(product)
    .leftJoin(brand, eq(brand.id, product.brandId))
    .where(eq(product.slug, slug))
    .limit(1);
  return rows[0];
}

export async function resolveProductSlug(db: Database, slug: string): Promise<SlugResolution> {
  const direct = await findBySlug(db, slug);
  if (direct) {
    return { status: "found", product: toProductDetail(direct) };
  }

  const historyRows = await db
    .select({ productId: productSlugHistory.productId })
    .from(productSlugHistory)
    .where(eq(productSlugHistory.slug, slug))
    .limit(1);
  const historyRow = historyRows[0];
  if (!historyRow) {
    return { status: "not_found" };
  }

  const currentRows = await db
    .select({ slug: product.slug })
    .from(product)
    .where(eq(product.id, historyRow.productId))
    .limit(1);
  const current = currentRows[0];
  if (!current) {
    return { status: "not_found" };
  }

  return { status: "redirect", canonicalSlug: current.slug };
}
