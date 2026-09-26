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
  variantKey,
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

type BatchRow = OfferVariantRow & {
  product_id: string;
  merchant_id: string;
  merchant_name: string;
  trust_score: number;
  current_price: string;
  list_price: string | null;
  shipping_cost: string | null;
  free_shipping_threshold: string | null;
  offer_in_stock: boolean;
};

async function loadBatch(db: Database, productIds: readonly number[]) {
  if (productIds.length === 0) return new Map<number, BatchRow[]>();
  const result = await db.execute<BatchRow>(sql`
    SELECT o.product_id, o.id AS offer_id, o.merchant_id, m.name AS merchant_name, m.trust_score,
           o.current_price, o.list_price, o.shipping_cost, o.free_shipping_threshold,
           o.in_stock AS offer_in_stock, o.title_raw,
           ov.id AS variant_id, ov.size_label, ov.size_norm, ov.in_stock, ov.price_override
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id
      LEFT JOIN offer_variant ov ON ov.offer_id = o.id
     WHERE o.product_id = ANY(${sql.param([...productIds])}::bigint[])
       AND o.is_active AND o.current_price IS NOT NULL
     ORDER BY o.product_id, o.id, ov.id
  `);
  const byProduct = new Map<number, BatchRow[]>();
  for (const row of result.rows) {
    const list = byProduct.get(Number(row.product_id)) ?? [];
    list.push(row);
    byProduct.set(Number(row.product_id), list);
  }
  return byProduct;
}

function offerInputsFromBatch(rows: readonly BatchRow[]): OfferInput[] {
  const offers = new Map<number, MerchantOffer>();
  for (const row of rows) {
    const offerId = Number(row.offer_id);
    if (offers.has(offerId)) continue;
    offers.set(offerId, {
      offerId,
      merchantId: Number(row.merchant_id),
      merchantSlug: "",
      merchantName: row.merchant_name,
      merchantTrustScore: row.trust_score,
      currentPrice: Number(row.current_price),
      listPrice: row.list_price === null ? null : Number(row.list_price),
      shippingCost: row.shipping_cost === null ? null : Number(row.shipping_cost),
      freeShippingThreshold:
        row.free_shipping_threshold === null ? null : Number(row.free_shipping_threshold),
      effectiveShipping: 0,
      effectiveTotal: 0,
      inStock: row.offer_in_stock,
      url: "",
    });
  }
  return toOfferInputs([...offers.values()], rows);
}

/**
 * Kartlar icin (0037): `min_price` bu urunlerde "baslangic fiyati"dir, cunku
 * urun sayfasiyla AYNI kurala gore varyantlar fiyati etkiliyor
 * (`buildPriceComparison(...).mode === "variants"`). Tek sorgu.
 */
export async function getStartingFromProductIds(
  db: Database,
  productIds: readonly number[],
): Promise<Set<number>> {
  const byProduct = await loadBatch(db, productIds);
  const flagged = new Set<number>();
  for (const [productId, rows] of byProduct) {
    if (buildPriceComparison(offerInputsFromBatch(rows), null).mode === "variants") {
      flagged.add(productId);
    }
  }
  return flagged;
}

/**
 * Varyant anahtari -> herhangi bir uyumlu teklifte stokta mi (0037). Stok
 * alarmi bunu kullanir; anahtar kurali urun sayfasindakiyle aynidir.
 */
export async function getVariantStock(
  db: Database,
  productId: number,
): Promise<Map<string, boolean>> {
  const rows = (await loadBatch(db, [productId])).get(productId) ?? [];
  const stock = new Map<string, boolean>();
  for (const offer of offerInputsFromBatch(rows)) {
    for (const variant of offer.variants) {
      const info = variantKey(variant);
      if (info) stock.set(info.key, (stock.get(info.key) ?? false) || variant.inStock);
    }
  }
  return stock;
}

/**
 * Kart listelerine `priceFromVariants` ekler (0037): true ise kartin fiyati
 * "...'den baslayan" olarak okunmalidir. Tek toplu sorgu.
 */
export async function withStartingFrom<T extends { productId: number }>(
  db: Database,
  items: readonly T[],
): Promise<(T & { priceFromVariants: boolean })[]> {
  const flagged = await getStartingFromProductIds(
    db,
    items.map((item) => item.productId),
  );
  return items.map((item) => ({ ...item, priceFromVariants: flagged.has(item.productId) }));
}
