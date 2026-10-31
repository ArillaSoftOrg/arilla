/**
 * Bir ürünün TRY dışı (yurt dışı) teklifleri (karar 0121; gösterim kuralları 0113/0114).
 *
 * Ürün sayfasının TL karşılaştırma listesi (`compareMerchants`) ve fiyat özeti yalnızca
 * TRY teklifi sayar; AliExpress gibi USD teklifler burada KENDİ para birimiyle ve fiyatın
 * gözlendiği zamanla gösterilir. TCMB kuru varsa yaklaşık TL, kur tarihiyle eklenir; yoksa
 * eklenmez (uydurulmaz). Kargo/gümrük/vergi bilinmediği için toplam fiyat doğrulanmış
 * değildir ve bu teklifler fiyat sıralamasına girmez: en yeni gözlenen önce.
 *
 * Karar 0156: beslemede uzun süredir görülmeyen (doğrulanamayan) teklif listeye girmez;
 * nedenini söylemek için bkz. `getProductUnverifiedForeignOffers`.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { type ApproxTry, approximateTry, type FxQuote, latestFxQuote } from "../pricing/fx.ts";
import { offerVerifiedSql } from "./freshness.ts";

export type SourceStatus = "current" | "not_current" | "unknown";

export interface ProductForeignOffer {
  offerId: number;
  merchantName: string;
  currency: string;
  priceMinor: number;
  listPriceMinor: number | null;
  /** Fiyatın kaynakta en son GÖZLENDİĞİ an (`price_point`); yoksa son görülme. */
  priceObservedAt: Date;
  /** Son fiyat kaydı (`price_point`); kayıt yoksa null. Doğrulama zamanı DEĞİLDİR. */
  priceChangedAt: Date | null;
  /** Teklifin beslemede son GÖRÜLDÜĞÜ an (üyelik ya da teklif satırı). */
  lastSeenAt: Date;
  /**
   * Teklif, beslemenin son başarılı (`complete`) sürümünde var mı. `unknown`: besleme
   * üyeliği yok (ör. toplayıcı); güncel ya da eski diye iddia edilmez.
   */
  sourceStatus: SourceStatus;
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
  seen_at: string;
  source_state: string | null;
};

export const FOREIGN_OFFERS_LIMIT = 10;

export async function getProductForeignOffers(
  db: Database,
  productId: number,
  now: Date = new Date(),
): Promise<ProductForeignOffer[]> {
  const result = await db.execute<Row>(sql`
    SELECT o.id, m.name AS merchant_name, o.currency, o.current_price, o.list_price,
           pp.observed_at, o.last_seen_at,
           GREATEST(o.last_seen_at, (SELECT max(fm.last_seen_at) FROM feed_source_offer fm
                                      WHERE fm.offer_id = o.id)) AS seen_at,
           (SELECT CASE WHEN count(*) = 0 THEN NULL
                        WHEN COALESCE(bool_or(m2.last_snapshot_id = ls.id), false) THEN 'current'
                        ELSE 'not_current' END
              FROM feed_source_offer m2
              JOIN LATERAL (SELECT max(s.id) AS id FROM source_snapshot s
                             WHERE s.feed_source_id = m2.feed_source_id
                               AND s.status = 'complete') ls ON true
             WHERE m2.offer_id = o.id) AS source_state
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
      priceChangedAt: row.observed_at === null ? null : new Date(row.observed_at),
      lastSeenAt: new Date(row.seen_at),
      sourceStatus:
        row.source_state === "current" || row.source_state === "not_current"
          ? row.source_state
          : "unknown",
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

/**
 * Yurt dışı teklifin zaman satırları: son fiyat kaydı ile kaynakta son görülme AYRI söylenir.
 * Son sürümde olmayan teklif "güncel" diye sunulmaz; fiyat gizlenmez (MVP kararı, 0156
 * politikası açılmadan).
 */
export function foreignOfferTimeNotes(
  offer: Pick<ProductForeignOffer, "priceChangedAt" | "lastSeenAt" | "sourceStatus">,
  formatDate: (date: Date) => string,
): string[] {
  const notes: string[] = [];
  if (offer.priceChangedAt) notes.push(`Son fiyat kaydı ${formatDate(offer.priceChangedAt)}`);
  notes.push(`Kaynakta en son ${formatDate(offer.lastSeenAt)} görüldü`);
  if (offer.sourceStatus === "not_current") {
    notes.push("Kaynağın son sürümünde yok; güncel olarak doğrulanamadı");
  }
  return notes;
}
