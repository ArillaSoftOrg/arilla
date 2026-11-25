/**
 * Ürün sayfası schema.org `Product` yapılandırılmış verisi (docs/routes.md "Teknik kurallar").
 *
 * Google Product sonucu `offers`, `review` ya da `aggregateRating`ten en az birini ister;
 * yorum/puan verimiz yok, bu yüzden teklifsiz üründe `Product` hiç basılmaz (yarım veri
 * Rich Results Test'te hata üretir). Fiyatlar kuruştan TL'ye yalnızca gösterim için çevrilir.
 * `url` mutlak olmalı: `siteUrl` yoksa url alanları atlanır.
 */

export interface JsonLdOfferRow {
  offerId: number;
  inStock: boolean;
  stockUnknown?: boolean;
}

export interface JsonLdVariantRow extends JsonLdOfferRow {
  priceKurus: number;
  variantLabel?: string | null;
}

export interface JsonLdMerchantOffer extends JsonLdOfferRow {
  /** Kuruş cinsinden güncel fiyat. */
  currentPrice: number;
}

export interface ProductJsonLdInput {
  slug: string;
  title: string;
  brandName?: string | null;
  imageUrls: readonly string[];
  siteUrl: string | null | undefined;
  /** Varyant modu (0037); yoksa null. */
  variantMode: { selectedKey: string | null; rows: readonly JsonLdVariantRow[] } | null;
  merchantOffers: readonly JsonLdMerchantOffer[];
}

function kurusToPrice(kurus: number): string {
  return (kurus / 100).toFixed(2);
}

function schemaAvailability(row: JsonLdOfferRow): { availability?: string } {
  if (row.stockUnknown) return {};
  return { availability: `https://schema.org/${row.inStock ? "InStock" : "OutOfStock"}` };
}

function offerUrl(siteUrl: string | null | undefined, offerId: number): { url?: string } {
  return siteUrl ? { url: `${siteUrl}/git/${offerId}?surface=structured_data` } : {};
}

function offersFor(input: ProductJsonLdInput): unknown {
  const { variantMode, merchantOffers, siteUrl } = input;
  if (variantMode && variantMode.rows.length > 0 && !variantMode.selectedKey) {
    // 0037: seçim yokken teklifler FARKLI boyutlardır; bir fiyat ARALIĞI olarak bildirilir.
    const prices = variantMode.rows.map((row) => row.priceKurus);
    return {
      "@type": "AggregateOffer",
      priceCurrency: "TRY",
      lowPrice: kurusToPrice(Math.min(...prices)),
      highPrice: kurusToPrice(Math.max(...prices)),
      offerCount: new Set(variantMode.rows.map((row) => row.offerId)).size,
    };
  }
  if (variantMode) {
    // Seçili varyant: yalnızca uyumlu satırlar (hepsi aynı boyut).
    if (variantMode.rows.length === 0) return null;
    return variantMode.rows.map((row) => ({
      "@type": "Offer",
      ...(row.variantLabel ? { name: row.variantLabel } : {}),
      price: kurusToPrice(row.priceKurus),
      priceCurrency: "TRY",
      ...schemaAvailability(row),
      ...offerUrl(siteUrl, row.offerId),
    }));
  }
  if (merchantOffers.length === 0) return null;
  return merchantOffers.map((offer) => ({
    "@type": "Offer",
    price: kurusToPrice(offer.currentPrice),
    priceCurrency: "TRY",
    ...schemaAvailability(offer),
    ...offerUrl(siteUrl, offer.offerId),
  }));
}

/** Teklif yoksa `null`: sayfa JSON-LD betiğini hiç basmaz. */
export function productJsonLd(input: ProductJsonLdInput): Record<string, unknown> | null {
  const offers = offersFor(input);
  if (offers === null) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.title,
    ...(input.brandName ? { brand: { "@type": "Brand", name: input.brandName } } : {}),
    ...(input.imageUrls.length > 0 ? { image: [...input.imageUrls] } : {}),
    ...(input.siteUrl ? { url: `${input.siteUrl}/urun/${input.slug}` } : {}),
    offers,
  };
}
