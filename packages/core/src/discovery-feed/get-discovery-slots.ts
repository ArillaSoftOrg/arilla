/**
 * `/` (ilk 20) ve `/kesfet` (curated + organic ayrımı) ortak okuma yolu.
 * `discovery_slot` zaten günlük üretilmiş bir tablo - istek yolu yalnızca
 * okur (CLAUDE.md kural 2).
 */

import { type Database, discoverySlot, product, publicFind } from "@arilla/db";
import { asc, eq } from "drizzle-orm";
import type { DiscoveryFeedItem } from "./types.ts";

export async function getDiscoverySlots(
  db: Database,
  slotDate: string,
): Promise<DiscoveryFeedItem[]> {
  const rows = await db
    .select({
      productId: product.id,
      slug: product.slug,
      title: product.title,
      primaryImageUrl: product.primaryImageUrl,
      minPrice: product.minPrice,
      offerCount: product.offerCount,
      source: discoverySlot.source,
      foundLabel: publicFind.foundLabel,
    })
    .from(discoverySlot)
    .innerJoin(product, eq(product.id, discoverySlot.productId))
    .leftJoin(publicFind, eq(publicFind.productId, discoverySlot.productId))
    .where(eq(discoverySlot.slotDate, slotDate))
    .orderBy(asc(discoverySlot.position));

  return rows;
}
