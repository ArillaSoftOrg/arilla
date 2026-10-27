/**
 * Bir ürünün TRY dışı (yurt dışı) teklifleri (karar 0121; gösterim kuralları 0113/0114).
 *
 * Ürün sayfasının TL karşılaştırma listesi (`compareMerchants`) ve fiyat özeti yalnızca
 * TRY teklifi sayar; AliExpress gibi USD teklifler burada KENDİ para birimiyle ve fiyatın
 * gözlendiği zamanla gösterilir. TCMB kuru varsa yaklaşık TL, kur tarihiyle eklenir; yoksa
 * eklenmez (uydurulmaz). Kargo/gümrük/vergi bilinmediği için toplam fiyat doğrulanmış
 * değildir ve bu teklifler fiyat sıralamasına girmez: en yeni gözlenen önce.
 *
 * Karar 0155: beslemede uzun süredir görülmeyen (doğrulanamayan) teklif listeye girmez;
 * nedenini söylemek için bkz. `getProductUnverifiedForeignOffers`.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { type ApproxTry, approximateTry, type FxQuote, latestFxQuote } from "../pricing/fx.ts";
import { offerVerifiedSql } from "./freshness.ts";

export interface ProductForeignOffer {
  offerId: number;
  merchantName: string;
  currency: string;
  priceMinor: number;
  listPriceMinor: number | null;
  /** Fiyatın kaynakta en son GÖZLENDİĞİ an (`price_point`); yoksa son görülme. */
  priceObservedAt: Date;
  /** Yalnızca kur varsa; yoksa null. */
  approx: ApproxTry | null;
}

type Row = {
  id: string;
  merchant_name: string;
  currency: string;
  current_price: string;
  list_price: string | null;
  observed_at: string | null;
  last_seen_at: string;
};

export const FOREIGN_OFFERS_LIMIT = 10;

export async function getProductForeignOffers(
  db: Database,
  productId: number,
  now: Date = new Date(),
): Promise<ProductForeignOffer[]> {
  const result = await db.execute<Row>(sql`
    SELECT o.id, m.name AS merchant_name, o.currency, o.current_price, o.list_price,
           pp.observed_at, o.last_seen_at
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id AND m.is_active
      LEFT JOIN LATERAL (
          SELECT observed_at FROM price_point
           WHERE offer_id = o.id ORDER BY observed_at DESC LIMIT 1
      ) pp ON true
     WHERE o.product_id = ${productId}
       AND o.is_active AND o.in_stock
       AND o.currency <> 'TRY'
       AND o.current_price IS NOT NULL AND o.current_price > 0
       AND ${offerVerifiedSql("o")}
     ORDER BY o.last_seen_at DESC, o.id DESC
     LIMIT ${FOREIGN_OFFERS_LIMIT}
  `);
  const quotes = new Map<string, FxQuote | null>();
  for (const currency of new Set(result.rows.map((row) => row.currency))) {
    quotes.set(currency, await latestFxQuote(db, currency));
  }
  return result.rows.map((row) => {
    const priceMinor = Number(row.current_price);
    return {
      offerId: Number(row.id),
      merchantName: row.merchant_name,
      currency: row.currency,
      priceMinor,
      listPriceMinor: row.list_price === null ? null : Number(row.list_price),
      priceObservedAt: new Date(row.observed_at ?? row.last_seen_at),
      approx: approximateTry(priceMinor, row.currency, quotes.get(row.currency) ?? null, now),
    };
  });
}

/**
 * Ürün sayfası başlığında gösterilecek yurt dışı teklif (karar 0127): yalnızca TL
 * teklifi YOKKEN. TL teklif varsa başlık onundur; yurt dışı tutar TL ile yarıştırılmaz.
 * Fiyat sıralaması yoktur (toplam doğrulanmadı): liste sırası, yani en yeni gözlenen.
 */
export function foreignHeadlineOffer(
  hasTryOffer: boolean,
  offers: readonly ProductForeignOffer[],
): ProductForeignOffer | null {
  return hasTryOffer ? null : (offers[0] ?? null);
}
