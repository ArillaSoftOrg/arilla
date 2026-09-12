/**
 * `/gecmis` (docs/pages.md: "silme düğmesi zorunludur ve gerçekten
 * silmelidir"). `product_view` yazımı burada YOK - docs/kvkk.md ve
 * `packages/db/src/schema/discovery.ts` yorumu: "Açık rıza gerekir" -
 * kayıt E3'ün rıza tercihleri UI'ı geldiğinde eklenir. Bu modül yalnızca
 * okuma ve silme sağlar; yazma yolu olmadığı sürece liste her zaman boş
 * kalır, ki bu KVKK ihlali değil doğru varsayılan (opt-out değil).
 */

import { type Database, product, productView } from "@arilla/db";
import { desc, eq } from "drizzle-orm";
import type { HistoryItemView } from "./types.ts";

const DEFAULT_LIMIT = 50;

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
