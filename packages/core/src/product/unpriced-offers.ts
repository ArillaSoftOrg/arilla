/**
 * Fiyatı doğrulanmamış teklifler (karar 0120): sitemap keşfinden açılan ürünlerde mağazaya
 * çıkış. Fiyat GÖSTERİLMEZ ve uydurulmaz; çıkış yine `/git` üzerinden `click` kaydı üretir
 * (CLAUDE.md kural 8). Fiyatlı teklif varsa bu liste kullanılmaz: karşılaştırma oradadır.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

export interface UnpricedOfferExit {
  offerId: number;
  merchantName: string;
  lastSeenAt: Date;
}

export async function listUnpricedOfferExits(
  db: Database,
  productId: number,
  limit = 3,
): Promise<UnpricedOfferExit[]> {
  const result = await db.execute<{ id: string; name: string; last_seen_at: string }>(sql`
    SELECT o.id, m.name, o.last_seen_at
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id
     WHERE o.product_id = ${productId}
       AND o.is_active AND m.is_active
       AND o.current_price IS NULL
     ORDER BY o.last_seen_at DESC, o.id
     LIMIT ${Math.min(Math.max(limit, 1), 10)}
  `);
  return result.rows.map((r) => ({
    offerId: Number(r.id),
    merchantName: r.name,
    lastSeenAt: new Date(r.last_seen_at),
  }));
}
