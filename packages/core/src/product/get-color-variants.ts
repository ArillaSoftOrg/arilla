import { type Database, product } from "@arilla/db";
import { and, eq, ne } from "drizzle-orm";
import type { ColorVariant } from "./result-types.ts";

/** docs/pages.md "Diger renkler": ayni model_key'i paylasan diger urunler. */
export async function getColorVariants(
  db: Database,
  modelKey: string,
  excludeProductId: number,
): Promise<ColorVariant[]> {
  const rows = await db
    .select({
      productId: product.id,
      slug: product.slug,
      color: product.color,
      primaryImageUrl: product.primaryImageUrl,
    })
    .from(product)
    .where(and(eq(product.modelKey, modelKey), ne(product.id, excludeProductId)));

  return rows;
}
