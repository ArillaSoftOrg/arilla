/**
 * Urun sayfasi gozlemi -> mevcut PostgreSQL katalog modeline (karar 0111/0113, main sema)
 * uygun SATIR ONIZLEMESI. Veritabanina yazmaz; production aktarimi bu dalda yoktur.
 *
 * Eslesme (belge 14 §4 ile ayni):
 *  - merchant: tek satir `trendyol`.
 *  - seller: (merchant, external_id = sayisal satici kimligi). Ad kimlik degildir.
 *  - offer: satici basina; external_id = "<contentId>:<saticiId>", url = kanonik adres +
 *    `?merchantId=` (saticiya ozgu bag), seller_id dolu.
 *  - offer_variant: varyant basina; external_id = itemNumber; gtin yalnizca GS1 gecerliyse.
 *  - price_point: INSERT adayi; yalnizca fiyat dogrulanmis ise (uydurma yok).
 *  - Kaynak ve dogrulama zamani her satirda: provider + observed_at.
 *
 * Mevcut CHECK'lere UYMAYAN degerler acikca isaretlenir (`schemaGaps`); migration karari
 * (0117 §Sonuclar) olmadan yazilamaz.
 */

import type { SitemapMatch } from "./sitemap-match.ts";
import type { TrendyolProductPageObservation } from "./trendyol-product-page.ts";

export const PROVIDER = "trendyol_browser_page" as const;

export interface CatalogRowPreview {
  provider: typeof PROVIDER;
  observedAt: string;
  sitemap: SitemapMatch;
  seller: { external_id: string; name: string | null } | null;
  offer: {
    external_id: string;
    url: string;
    title_raw: string;
    brand_raw: string | null;
    category_raw: string | null;
    image_url: string | null;
    /** Sayfanin "odenecek" gosterdigi fiyat (discounted katmani), kurus. */
    current_price: number | null;
    /** Ustu cizili fiyat; yalnizca current_price'tan yuksekse. */
    list_price: number | null;
    currency: "TRY";
    in_stock: boolean;
    attributes_raw: Record<string, string | number | null>;
  } | null;
  variants: {
    external_id: string;
    size_label: string | null;
    in_stock: boolean;
    /** Varyant fiyati teklif fiyatindan farkliysa. */
    price_override: number | null;
    gtin: string | null;
  }[];
  pricePoint: {
    observed_at: string;
    price: number;
    list_price: number | null;
    in_stock: boolean;
  } | null;
  /** Fiyat katmanlari ve kaynak etiketleri: price_verification.discount_conditions adayi. */
  priceLayers: Record<string, unknown> | null;
  /** Kazanan saticinin listesinde olmayan (fiyati baska saticiya ait olabilecek) varyant sayisi. */
  unattributedVariants: number;
  /** Neden satir uretilemedi ya da hangi alan eksik. */
  skipped: string[];
  /** Mevcut CHECK kisitlarina uymayan ve migration gerektiren degerler. */
  schemaGaps: string[];
}

export function catalogRowsFromObservation(
  obs: TrendyolProductPageObservation,
  sitemap: SitemapMatch,
): CatalogRowPreview {
  const skipped: string[] = [];
  const schemaGaps = [
    "merchant.source_type: 'browser_page' yok (izinli degerler: xml_feed, api, affiliate_network, user_discovered, shopify)",
    "offer.discovery_source: 'browser' yok (izinli: feed, api, user_link)",
    "offer_variant.gtin_source: 'page_ssr' yeni deger",
  ];
  const base = {
    provider: PROVIDER,
    observedAt: obs.observedAt,
    sitemap,
    variants: [] as CatalogRowPreview["variants"],
    pricePoint: null,
    priceLayers: null,
    unattributedVariants: obs.variants.filter((v) => !v.sellerScoped).length,
    schemaGaps,
  };
  if (obs.staleEmbeddedData) skipped.push("stale_embedded_data");
  if (!obs.contentId || !obs.url) skipped.push("no_canonical_content");
  if (!obs.seller) skipped.push("no_seller");
  if (!obs.title) skipped.push("no_title");
  if (skipped.length) return { ...base, seller: null, offer: null, skipped };

  const seller = obs.seller as { id: string; name: string | null };
  const offer = obs.offer;
  const price = offer?.currency === "TRY" ? offer.prices.discounted : null;
  if (price == null) skipped.push("no_verified_price");
  const inStock =
    offer?.inStock ??
    (obs.jsonLd?.availability === "in_stock"
      ? true
      : obs.jsonLd?.availability === "out_of_stock"
        ? false
        : null);
  if (inStock == null) skipped.push("no_stock_signal");
  const original = offer?.prices.original ?? null;

  return {
    ...base,
    seller: { external_id: seller.id, name: seller.name },
    offer: {
      external_id: `${obs.contentId}:${seller.id}`,
      url: `${obs.url}?merchantId=${seller.id}`,
      title_raw: obs.title as string,
      brand_raw: obs.brand,
      category_raw: obs.category,
      image_url: obs.images[0] ?? null,
      current_price: price,
      list_price: price != null && original != null && original > price ? original : null,
      currency: "TRY",
      // Stok bilinmiyorsa stokta sayilmaz (offer.in_stock NOT NULL; varsayilan TRUE yaniltir).
      in_stock: inStock === true,
      attributes_raw: {
        trendyolContentId: obs.contentId,
        trendyolGroupId: obs.groupId,
        trendyolItemNumber: offer?.itemNumber ?? null,
        trendyolListingId: offer?.listingId ?? null,
        otherMerchantCount: obs.otherMerchantCount,
      },
    },
    // Yalnizca bu saticinin listesindeki varyantlar; digerlerinin fiyati baska saticiya ait olabilir.
    variants: obs.variants
      .filter((v) => v.itemNumber && v.sellerScoped)
      .map((v) => ({
        external_id: v.itemNumber as string,
        size_label: v.label,
        in_stock: v.inStock === true,
        price_override:
          v.priceKurus != null && price != null && v.priceKurus !== price ? v.priceKurus : null,
        gtin: v.gtin14,
      })),
    pricePoint:
      price != null && inStock != null
        ? {
            observed_at: obs.observedAt,
            price,
            list_price: original != null && original > price ? original : null,
            in_stock: inStock,
          }
        : null,
    priceLayers: offer
      ? {
          layer: "discounted",
          prices: offer.prices,
          discountPercent: offer.discountPercent,
          tags: offer.tags,
          campaign: offer.campaign,
          jsonLdPrice: obs.jsonLd?.priceKurus ?? null,
          jsonLdMatchesDiscounted: obs.jsonLdMatchesDiscounted,
        }
      : null,
    skipped,
  };
}
