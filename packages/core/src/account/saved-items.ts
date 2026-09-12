/**
 * `/kaydettiklerim` (docs/pages.md, docs/routes.md). `saved_item_uniq (user_id,
 * product_id)` kisiti idempotent kaydetmeyi zaten zorluyor - `onConflictDoNothing`
 * ile ikinci "Kaydet" tiki hata degil no-op olur.
 */

import { type Database, product, savedItem } from "@arilla/db";
import { and, desc, eq } from "drizzle-orm";
import type { SavedItemView } from "./types.ts";

export interface SaveItemInput {
  userId: number;
  productId: number;
  sourceCreatorId?: number | null;
}

export interface SaveItemResult {
  /** false: zaten kayitliydi, yeni satir acilmadi. */
  created: boolean;
}

export async function saveItem(db: Database, input: SaveItemInput): Promise<SaveItemResult> {
  const inserted = await db
    .insert(savedItem)
    .values({
      userId: input.userId,
      productId: input.productId,
      sourceCreatorId: input.sourceCreatorId ?? null,
    })
    .onConflictDoNothing({ target: [savedItem.userId, savedItem.productId] })
    .returning({ id: savedItem.id });

  return { created: inserted.length > 0 };
}

export interface RemoveSavedItemInput {
  userId: number;
  productId: number;
}

export async function removeSavedItem(db: Database, input: RemoveSavedItemInput): Promise<void> {
  await db
    .delete(savedItem)
    .where(and(eq(savedItem.userId, input.userId), eq(savedItem.productId, input.productId)));
}

export async function listSavedItems(db: Database, userId: number): Promise<SavedItemView[]> {
  const rows = await db
    .select({
      productId: product.id,
      slug: product.slug,
      title: product.title,
      primaryImageUrl: product.primaryImageUrl,
      minPrice: product.minPrice,
      offerCount: product.offerCount,
      savedAt: savedItem.createdAt,
    })
    .from(savedItem)
    .innerJoin(product, eq(product.id, savedItem.productId))
    .where(eq(savedItem.userId, userId))
    .orderBy(desc(savedItem.createdAt));

  return rows;
}
