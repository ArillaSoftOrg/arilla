/**
 * `/gecmis` ve `/hesap` "Son baktıkların" (docs/pages.md: "silme düğmesi
 * zorunludur ve gerçekten silmelidir"). Kaynak `product_view`: kullanıcı başına
 * ürün başına TEK satır, son 50 ile sınırlı (0009).
 *
 * Yazma YALNIZCA `recordProductView` ile ve YALNIZCA hesabın
 * `browsing_history` rızası verilmişken yapılır (docs/kvkk.md: opt-in). Bu,
 * analitik rızasından (`activity/record.ts`) ayrıdır: kişiye gösterilen
 * özellik başka, davranışsal ölçüm başka rızadır.
 */

import { type Database, product, productView } from "@arilla/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { getLatestConsents } from "../consent/account-consent.ts";
import type { HistoryItemView } from "./types.ts";

const DEFAULT_LIMIT = 50;
/** `product_view` kullanıcı başına en fazla bu kadar satır tutar (0009). */
export const PRODUCT_VIEW_RETENTION = 50;
/** `product_view.session_id` NOT NULL; oturum kimliği saklanmaz (kişisel veri azaltma). */
const PRODUCT_VIEW_SESSION = "account";

export type RecordProductViewOutcome = "recorded" | "no_consent" | "no_user";

/**
 * Girişli kullanıcının ürün görüntülemesini "son baktıkların" listesine yazar.
 * Aynı ürün tekrar açılırsa satır güncellenir (yeni kopya yok), liste
 * en yeni başta kalır. Rıza yoksa hiçbir şey yazılmaz.
 */
export async function recordProductView(
  db: Database,
  input: { userId: number | null | undefined; productId: number; now?: Date },
): Promise<RecordProductViewOutcome> {
  const userId = input.userId;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return "no_user";
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('product_view'), ${userId}::int)`);
    const latest = await getLatestConsents(tx, userId, ["browsing_history"]);
    if (latest.get("browsing_history")?.granted !== true) return "no_consent";

    const updated = await tx
      .update(productView)
      .set({ viewedAt: now })
      .where(and(eq(productView.userId, userId), eq(productView.productId, input.productId)))
      .returning({ id: productView.id });
    if (updated.length === 0) {
      await tx.insert(productView).values({
        userId,
        sessionId: PRODUCT_VIEW_SESSION,
        productId: input.productId,
        viewedAt: now,
      });
    }
    await tx.execute(sql`
      DELETE FROM product_view
       WHERE user_id = ${userId}
         AND id NOT IN (
           SELECT id FROM product_view WHERE user_id = ${userId}
            ORDER BY viewed_at DESC, id DESC LIMIT ${PRODUCT_VIEW_RETENTION}
         )
    `);
    return "recorded";
  });
}

export async function listHistory(
  db: Database,
  userId: number,
  limit = DEFAULT_LIMIT,
): Promise<HistoryItemView[]> {
  const rows = await db
    .select({
      productId: product.id,
      slug: product.slug,
      title: product.title,
      primaryImageUrl: product.primaryImageUrl,
      minPrice: product.minPrice,
      offerCount: product.offerCount,
      viewedAt: productView.viewedAt,
    })
    .from(productView)
    .innerJoin(product, eq(product.id, productView.productId))
    .where(eq(productView.userId, userId))
    .orderBy(desc(productView.viewedAt))
    .limit(limit);

  return rows;
}

export async function clearHistory(db: Database, userId: number): Promise<void> {
  await db.delete(productView).where(eq(productView.userId, userId));
}
