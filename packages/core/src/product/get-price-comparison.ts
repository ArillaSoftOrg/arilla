/**
 * Urun sayfasi icin varyant duyarli karsilastirma girdisi (docs/decisions/0033).
 *
 * `compareMerchants()` teklif basina TEK fiyat (offer'in en ucuz varyanti)
 * dondurur; varyantlar burada eklenir:
 * - varyant satiri olan teklif: her `offer_variant` satiri kendi fiyatiyla
 *   (`price_override`, yoksa teklif fiyati) ve stoguyla;
 * - varyant satiri olmayan teklif: tek varyant, etiketi teklifin KENDI
 *   basligi (tek ve birimli miktar varsa `parseQuantity` onu okur).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { compareMerchants } from "../search/compare-merchants.ts";
import type { MerchantOffer } from "../search/result-types.ts";
import {
  buildPriceComparison,
  type OfferInput,
  type PriceComparison,
  type VariantInput,
} from "./variant-price.ts";

export type OfferVariantRow = Record<string, unknown> & {
  offer_id: string;
  title_raw: string;
  variant_id: string | null;
  size_label: string | null;
  size_norm: string | null;
  in_stock: boolean | null;
  price_override: string | null;
};

export interface ProductPriceComparison {
  /** Eski sirali teklif listesi (basit mod ve JSON-LD icin). */
  merchantOffers: MerchantOffer[];
  comparison: PriceComparison;
}

export function toOfferInputs(
  offers: readonly MerchantOffer[],
  rows: readonly OfferVariantRow[],
): OfferInput[] {
  // price_override NULL ise varyant teklif fiyatindan satilir (0005).
  const byOffer = new Map<
    number,
    { title: string; variants: (Omit<VariantInput, "priceKurus"> & { override: number | null })[] }
  >();
  for (const row of rows) {
    const offerId = Number(row.offer_id);
    const entry = byOffer.get(offerId) ?? { title: row.title_raw, variants: [] };
    if (row.variant_id !== null) {
      entry.variants.push({
        label: row.size_label,
        sizeNorm: row.size_norm,
        inStock: row.in_stock ?? false,
        fromVariantRow: true,
        override: row.price_override === null ? null : Number(row.price_override),
      });
    }
    byOffer.set(offerId, entry);
  }

  return offers.map((offer) => {
    const entry = byOffer.get(offer.offerId);
    const variants: VariantInput[] =
      entry && entry.variants.length > 0
        ? entry.variants.map(({ override, ...variant }) => ({
            ...variant,
            priceKurus: override ?? offer.currentPrice,
          }))
        : [
            {
              label: entry?.title ?? null,
              sizeNorm: null,
              priceKurus: offer.currentPrice,
              inStock: offer.inStock,
              fromVariantRow: false,
            },
          ];
    return {
      offerId: offer.offerId,
      merchantName: offer.merchantName,
      merchantTrustScore: offer.merchantTrustScore,
      currentPrice: offer.currentPrice,
      listPrice: offer.listPrice,
      shippingCost: offer.shippingCost,
      freeShippingThreshold: offer.freeShippingThreshold,
      inStock: offer.inStock,
      variants,
    };
  });
}

export async function getProductPriceComparison(
  db: Database,
  productId: number,
  selectedKey: string | null,
): Promise<ProductPriceComparison> {
  const merchantOffers = await compareMerchants(db, productId);
  if (merchantOffers.length === 0) {
    return { merchantOffers, comparison: { mode: "simple" } };
  }
  const result = await db.execute<OfferVariantRow>(sql`
    SELECT o.id AS offer_id, o.title_raw, ov.id AS variant_id, ov.size_label, ov.size_norm,
           ov.in_stock, ov.price_override
      FROM offer o
      LEFT JOIN offer_variant ov ON ov.offer_id = o.id
     WHERE o.product_id = ${productId} AND o.is_active AND o.current_price IS NOT NULL
     ORDER BY o.id, ov.id
  `);
  return {
    merchantOffers,
    comparison: buildPriceComparison(toOfferInputs(merchantOffers, result.rows), selectedKey),
  };
}
