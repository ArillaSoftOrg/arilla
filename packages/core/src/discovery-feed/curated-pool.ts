/**
 * "Curated havuz yükleme aracı" (docs/backlog.md E4). Web ekranı değil, bir
 * script'ten çağrılan çekirdek fonksiyon (bkz. `packages/core/scripts/
 * load-curated-pool.ts`) - docs/routes.md'nin `/yonetim/*` listesinde bu
 * işlem için ayrı bir ekran yok, ~300 ürünlük tek seferlik/seyrek bir toplu
 * yükleme için script yeterli.
 */

import { category, type Database, product, publicFind } from "@arilla/db";
import { and, eq } from "drizzle-orm";

export class ProductNotDiscoverableError extends Error {
  constructor(productId: number) {
    super(`urun ${productId} kesfet akisina giremez (kategori is_discoverable=false)`);
    this.name = "ProductNotDiscoverableError";
  }
}

export class ProductNotFoundError extends Error {
  constructor(productId: number) {
    super(`urun bulunamadi: ${productId}`);
    this.name = "ProductNotFoundError";
  }
}

/**
 * docs/routes.md "Soğuk başlangıç": temiz/yüksek çözünürlüklü fotoğraf, iyi
 * fiyat konumu, dengeli kategori dağılımı, stokta olma - bunlar editöryel
 * seçim kriterleri, kod burada yalnızca kategori güvenliğini ve ürünün var
 * olduğunu doğrular.
 */
export async function addToCuratedPool(db: Database, productId: number): Promise<void> {
  const rows = await db
    .select({ categoryIsDiscoverable: category.isDiscoverable })
    .from(product)
    .leftJoin(category, eq(category.id, product.categoryId))
    .where(eq(product.id, productId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new ProductNotFoundError(productId);
  }
  if (row.categoryIsDiscoverable === false) {
    throw new ProductNotDiscoverableError(productId);
  }

  await db
    .insert(publicFind)
    .values({ productId, source: "curated" })
    .onConflictDoUpdate({
      target: publicFind.productId,
      set: { source: "curated" },
    });
}

export async function removeFromCuratedPool(db: Database, productId: number): Promise<void> {
  await db
    .delete(publicFind)
    .where(and(eq(publicFind.productId, productId), eq(publicFind.source, "curated")));
}

export interface CuratedPoolItem {
  productId: number;
  slug: string;
  title: string;
}

export async function listCuratedPool(db: Database): Promise<CuratedPoolItem[]> {
  return db
    .select({ productId: product.id, slug: product.slug, title: product.title })
    .from(publicFind)
    .innerJoin(product, eq(product.id, publicFind.productId))
    .where(eq(publicFind.source, "curated"))
    .orderBy(product.id);
}
