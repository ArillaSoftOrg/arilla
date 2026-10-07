/**
 * `/gecmis` ve `/hesap` "Son baktıkların" (docs/pages.md: "silme düğmesi
 * zorunludur ve gerçekten silmelidir"). `product_view` kişisel veridir
 * (docs/kvkk.md): yalnızca girişli kullanıcı ve güncel `browsing_history`
 * rızası varken yazılır (`recordProductView`). Rıza yoksa hiçbir şey yazılmaz.
 *
 * Kullanıcı başına ürün başına TEK satır tutulur (şemada unique kısıt yok,
 * bu yüzden yazım kullanıcı başına danışma kilidi altında güncelle-yoksa-ekle
 * yapar); tekrar görüntülemede `viewed_at` güncellenir. Kullanıcı başına en
 * fazla `HISTORY_MAX_ROWS` satır kalır (0009 şema yorumu).
 */

import { type Database, product, productView, userConsent } from "@arilla/db";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { HistoryItemView } from "./types.ts";

const DEFAULT_LIMIT = 50;
export const HISTORY_MAX_ROWS = 50;
/** `product_view.session_id` NOT NULL; hesap geçmişi oturum kimliğine bağlanmaz. */
const HISTORY_SESSION_ID = "account";

export type RecordProductViewOutcome = "recorded" | "no_user" | "no_consent" | "invalid";

export interface RecordProductViewInput {
  userId: number | null | undefined;
  productId: number;
  now?: Date;
}

export async function recordProductView(
  db: Database,
  input: RecordProductViewInput,
): Promise<RecordProductViewOutcome> {
  const { userId, productId } = input;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return "no_user";
  if (!Number.isInteger(productId) || productId <= 0) return "invalid";
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('product_view'), ${userId}::int)`);

    const latest = await tx
      .select({ granted: userConsent.granted })
      .from(userConsent)
      .where(and(eq(userConsent.userId, userId), eq(userConsent.kind, "browsing_history")))
      .orderBy(desc(userConsent.grantedAt), desc(userConsent.id))
      .limit(1);
    if (latest[0]?.granted !== true) return "no_consent";

    const existing = await tx
      .select({ id: productView.id })
      .from(productView)
      .where(and(eq(productView.userId, userId), eq(productView.productId, productId)))
      .orderBy(desc(productView.viewedAt), desc(productView.id));
    const keep = existing[0];
    if (keep) {
      await tx.update(productView).set({ viewedAt: now }).where(eq(productView.id, keep.id));
      // Eski sürümlerden kalmış olabilecek yinelenenleri temizle.
      const extra = existing.slice(1).map((row) => row.id);
      if (extra.length > 0) await tx.delete(productView).where(inArray(productView.id, extra));
    } else {
      await tx.insert(productView).values({
        userId,
        sessionId: HISTORY_SESSION_ID,
        productId,
        viewedAt: now,
      });
    }

    const newest = await tx
      .select({ id: productView.id })
      .from(productView)
      .where(eq(productView.userId, userId))
      .orderBy(desc(productView.viewedAt), desc(productView.id))
      .limit(HISTORY_MAX_ROWS);
    if (newest.length === HISTORY_MAX_ROWS) {
      await tx.delete(productView).where(
        and(
          eq(productView.userId, userId),
          notInArray(
            productView.id,
            newest.map((row) => row.id),
          ),
        ),
      );
    }
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
    .orderBy(desc(productView.viewedAt), desc(productView.id))
    .limit(limit);

  return rows;
}

export async function clearHistory(db: Database, userId: number): Promise<void> {
  await db.delete(productView).where(eq(productView.userId, userId));
}
