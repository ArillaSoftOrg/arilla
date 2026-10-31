/**
 * docs/decisions/0019: architecture.md'nin "istek yolu fiyat gecmisini
 * asla taramaz" kuralina TEK istisna. Tek urune, 90 gune ve indekslere
 * (`offer_product_idx`, `price_point` PK `(offer_id, observed_at)`) sinirli - EXPLAIN ile
 * dogrulanmis, hicbir sequential scan yok.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import type { PriceHistoryPoint } from "./result-types.ts";

type RawRow = Record<string, unknown> & {
  day: string;
  min_price: string;
};

export async function getPriceHistory(
  db: Database,
  productId: number,
  days = 90,
): Promise<PriceHistoryPoint[]> {
  const result = await db.execute<RawRow>(sql`
    SELECT date_trunc('day', pp.observed_at)::date::text AS day, MIN(pp.price)::text AS min_price
    FROM price_point pp
    JOIN offer o ON o.id = pp.offer_id
    WHERE o.product_id = ${productId}
      -- price_point para birimi tasimaz; kuruş grafigi yalnizca TRY tekliflerden
      -- kurulur (yurt disi teklifin cent'i kurus gibi okunup MIN'i bozmasin).
      AND o.currency = 'TRY'
      AND pp.observed_at >= now() - (${days}::text || ' days')::interval
    GROUP BY 1
    ORDER BY 1
  `);

  return result.rows.map((row) => ({
    date: row.day,
    minPriceKurus: Number(row.min_price),
  }));
}

export interface ForeignPriceHistory {
  currency: string;
  /** Günlük en düşük fiyat, para biriminin küçük birimiyle (cent); TL'ye çevrilmez. */
  points: PriceHistoryPoint[];
}

/**
 * Yalnızca yurt dışı teklifi olan ürünün (ör. AliExpress, USD) fiyat geçmişi. Aynı kuralla
 * sınırlıdır: tek ürün, 90 gün, `offer_product_idx` + `price_point` PK. Para birimleri
 * karıştırılmaz: yalnızca `currency` parametresindeki teklifler sayılır. `price_point` para
 * birimi taşımaz, bu yüzden tutar çevrilmeden, teklifin kendi para birimiyle döner.
 * Nokta sentezlenmez; fiyat o gün kaydedilmediyse o gün için nokta yoktur.
 */
export async function getForeignPriceHistory(
  db: Database,
  productId: number,
  currency: string,
  days = 90,
): Promise<ForeignPriceHistory> {
  if (currency === "TRY") return { currency, points: [] };
  const result = await db.execute<RawRow>(sql`
    SELECT date_trunc('day', pp.observed_at)::date::text AS day, MIN(pp.price)::text AS min_price
    FROM price_point pp
    JOIN offer o ON o.id = pp.offer_id
    WHERE o.product_id = ${productId}
      AND o.currency = ${currency}
      AND pp.price > 0
      AND pp.observed_at >= now() - (${days}::text || ' days')::interval
    GROUP BY 1
    ORDER BY 1
  `);
  return {
    currency,
    points: result.rows.map((row) => ({ date: row.day, minPriceKurus: Number(row.min_price) })),
  };
}
