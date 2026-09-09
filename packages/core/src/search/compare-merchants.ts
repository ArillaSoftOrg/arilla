/**
 * `compareMerchants()` — docs/pages.md, urun sayfasi "Magaza listesi":
 * "Magaza listesi siralamasi: kargo dahil toplam fiyat. Komisyon orani
 * siralamaya girmez." Stokta olmayan teklifler gizlenmez, sadece isaretlenir
 * ("Stokta yoksa: urun gizlenmez").
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import type { MerchantOffer } from "./result-types.ts";

type RawRow = Record<string, unknown> & {
  offer_id: string;
  merchant_id: string;
  merchant_slug: string;
  merchant_name: string;
  trust_score: number;
  current_price: string;
  list_price: string | null;
  shipping_cost: string | null;
  free_shipping_threshold: string | null;
  in_stock: boolean;
  url: string;
  effective_shipping: string;
  effective_total: string;
};

export async function compareMerchants(db: Database, productId: number): Promise<MerchantOffer[]> {
  const result = await db.execute<RawRow>(sql`
    SELECT
      o.id AS offer_id, o.merchant_id, m.slug AS merchant_slug, m.name AS merchant_name,
      m.trust_score, o.current_price, o.list_price, o.shipping_cost,
      o.free_shipping_threshold, o.in_stock, o.url,
      (CASE
        WHEN o.free_shipping_threshold IS NOT NULL AND o.current_price >= o.free_shipping_threshold THEN 0
        ELSE COALESCE(o.shipping_cost, 0)
      END) AS effective_shipping,
      (o.current_price + (CASE
        WHEN o.free_shipping_threshold IS NOT NULL AND o.current_price >= o.free_shipping_threshold THEN 0
        ELSE COALESCE(o.shipping_cost, 0)
      END)) AS effective_total
    FROM offer o
    JOIN merchant m ON m.id = o.merchant_id
    WHERE o.product_id = ${productId}
      AND o.is_active
      AND o.current_price IS NOT NULL
    ORDER BY effective_total ASC, m.trust_score DESC, o.id ASC
  `);

  return result.rows.map((row) => ({
    offerId: Number(row.offer_id),
    merchantId: Number(row.merchant_id),
    merchantSlug: row.merchant_slug,
    merchantName: row.merchant_name,
    merchantTrustScore: row.trust_score,
    currentPrice: Number(row.current_price),
    listPrice: row.list_price === null ? null : Number(row.list_price),
    shippingCost: row.shipping_cost === null ? null : Number(row.shipping_cost),
    freeShippingThreshold:
      row.free_shipping_threshold === null ? null : Number(row.free_shipping_threshold),
    effectiveShipping: Number(row.effective_shipping),
    effectiveTotal: Number(row.effective_total),
    inStock: row.in_stock,
    url: row.url,
  }));
}
