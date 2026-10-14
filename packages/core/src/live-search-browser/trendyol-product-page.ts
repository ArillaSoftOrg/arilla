/**
 * Trendyol URUN sayfasindan (kullanicinin tarayicisinda, trendyol.com origin'inde acik
 * sayfa) yapilandirilmis veri cikarma. Ag istegi atmaz; yalnizca sayfanin sunucuda
 * gomdugu metinleri okur:
 *
 *  1) `window["__envoy__SHARED_PROPS"].product`: ad, marka, kategori, gorseller, renk grubu,
 *     kazanan teklif (`merchantListing.winnerVariant`: fiyat katmanlari, barkod, stok),
 *     satici (`merchantListing.merchant`), varyantlar (`variants[]`: beden, barkod, fiyat, stok).
 *  2) JSON-LD `Product` / `ProductGroup`: `offers.price`, `availability`; `hasVariant` renk
 *     kardesleridir (baska contentId), beden degil.
 *  3) `window["__envoy_side-other-seller__PROPS"].otherMerchantCount`: diger satici SAYISI.
 *     Diger saticilarin teklifleri sayfaya sonradan dahili servisten yuklenir; okunmaz.
 *
 * Veri en aza indirilir: saticinin vergi no, KEP e-postasi, adres ve unvan alanlari
 * sayfada bulunsa da OKUNMAZ (yalnizca `id` ve `name`).
 * Dogrulanamayan alan uretilmez: null kalir ve `missing`e yazilir.
 */

import { priceTextToKurus } from "../trendyol-landing/listing.ts";
import { findWindowJson, type PageInputs, parseJsonLd } from "./page-inputs.ts";

const ORIGIN = "https://www.trendyol.com";

type Json = Record<string, unknown>;

export interface PriceLayersKurus {
  /** Sayfanin "odenecek" olarak gosterdigi fiyat (sepet indirimi dahil olabilir). */
  discounted: number | null;
  /** Saticinin satis fiyati. */
  selling: number | null;
  /** Ustu cizili / liste fiyati. Trendyol'da `selling`den dusuk olabilir (gozlendi). */
  original: number | null;
  couponApplicable: number | null;
  afterNoLimitPromotions: number | null;
}

export interface TrendyolOfferObservation {
  itemNumber: string | null;
  listingId: string | null;
  barcode: string | null;
  /** GS1 kontrol basamagi dogru barkod, 14 haneye tamamlanmis; degilse null. */
  gtin14: string | null;
  currency: "TRY" | null;
  prices: PriceLayersKurus;
  /** Kaynagin verdigi yuzde; hesaplanmaz. */
  discountPercent: number | null;
  inStock: boolean | null;
  stockStatus: number | null;
  /** "Son N urun" sayisi; 0 = bildirilmedi. */
  runningOutQuantity: number | null;
  /** Kaynagin etiket kodlari (or. "kirmizi_kampanya_urunu", "lowest_price_duration_10"). */
  tags: string[];
  campaign: { id: string; name: string | null } | null;
}

export interface TrendyolVariantObservation {
  itemNumber: string | null;
  label: string | null;
  barcode: string | null;
  gtin14: string | null;
  priceKurus: number | null;
  inStock: boolean | null;
  isSelected: boolean;
  /**
   * Varyant kazanan saticinin listesinde (`merchantListing.variants`) var mi. Degilse fiyati
   * BASKA bir saticiya ait olabilir (Samba: urun duzeyinde 15, saticida 7 varyant); bu
   * saticinin teklifine baglanmaz.
   */
  sellerScoped: boolean;
}

export interface TrendyolProductPageObservation {
  kind: "trendyol-product-page";
  source: "ssr-shared-props" | "json-ld-only";
  observedAt: string;
  /** Kanonik adres: `https://www.trendyol.com/<marka>/<slug>-p-<contentId>` (sorgu yok). */
  url: string | null;
  contentId: string | null;
  /** Renk grubu (`productGroupId`). Sitemap'te yok. */
  groupId: string | null;
  title: string | null;
  brand: string | null;
  category: string | null;
  images: string[];
  seller: { id: string; name: string | null } | null;
  offer: TrendyolOfferObservation | null;
  variants: TrendyolVariantObservation[];
  jsonLd: {
    type: string;
    priceKurus: number | null;
    currency: "TRY" | null;
    availability: "in_stock" | "out_of_stock" | "unknown";
    /** Renk kardesleri: baska contentId'ler ve kendi teklif fiyatlari (satici belirsiz). */
    groupSiblings: { contentId: string; priceKurus: number | null }[];
  } | null;
  otherMerchantCount: number | null;
  /** JSON-LD fiyati ile kazanan teklifin `discounted` katmani esit mi (null: karsilastirilamaz). */
  jsonLdMatchesDiscounted: boolean | null;
  /**
   * Gomulu veri adresteki urune ait degil (or. sayfa ici gezinmeden sonra eski veri kaldi).
   * true ise gozlem kullanilmaz: tum alanlar bos birakilir.
   */
  staleEmbeddedData: boolean;
  missing: string[];
}

const obj = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const idStr = (v: unknown): string | null =>
  (typeof v === "number" || typeof v === "string") && /^\d+$/.test(String(v)) ? String(v) : null;
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) ? v : null;

/** Sayi ya da sayisal metin -> kurus (float aritmetigi yok; metin uzerinden). */
export function amountToKurus(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? priceTextToKurus(String(v)) : null;
  return priceTextToKurus(v);
}

/** `{value, text}` fiyat nesnesi ya da sayi -> kurus. */
function layer(v: unknown): number | null {
  const o = obj(v);
  return amountToKurus(o ? o.value : v);
}

/** GS1 kontrol basamagi (admin/catalog-quality.ts `isValidGtin` ile ayni kural). */
export function gtin14(raw: unknown): string | null {
  const code = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return null;
  const digits = [...code].map(Number);
  const check = digits[digits.length - 1];
  const total = digits
    .slice(0, -1)
    .reverse()
    .reduce((sum, d, i) => sum + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === check ? code.padStart(14, "0") : null;
}

export function canonicalProductUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw, ORIGIN);
    if (u.origin !== ORIGIN || !/^\/[^/]+\/[^/]+-p-\d+$/.test(u.pathname)) return null;
    return `${ORIGIN}${u.pathname}`;
  } catch {
    return null;
  }
}

const contentIdOf = (url: string | null) => url?.match(/-p-(\d+)$/)?.[1] ?? null;

function availability(v: unknown): "in_stock" | "out_of_stock" | "unknown" {
  const s = String(v ?? "").toLowerCase();
  if (s.endsWith("instock")) return "in_stock";
  if (s.endsWith("outofstock") || s.endsWith("soldout")) return "out_of_stock";
  return "unknown";
}

const currencyOf = (v: unknown): "TRY" | null => {
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  return s === "TRY" || s === "TL" ? "TRY" : null;
};

function readOffer(winner: Json | null, campaign: Json | null): TrendyolOfferObservation | null {
  if (!winner) return null;
  const price = obj(winner.price) ?? {};
  const barcode = str(winner.barcode) ?? idStr(winner.barcode);
  const tags = Array.isArray(winner.tagDetails)
    ? winner.tagDetails.map((t) => str(obj(t)?.tag)).filter((t): t is string => t != null)
    : [];
  const discountPercent = int(price.discountPercentage);
  return {
    itemNumber: idStr(winner.itemNumber),
    listingId: str(winner.listingId),
    barcode,
    gtin14: gtin14(barcode),
    currency: currencyOf(price.currency),
    prices: {
      discounted: layer(price.discountedPrice),
      selling: layer(price.sellingPrice),
      original: layer(price.originalPrice),
      couponApplicable: layer(price.couponApplicablePrice),
      afterNoLimitPromotions: layer(price.discountedPriceAfterNoLimitPromotions),
    },
    discountPercent: discountPercent && discountPercent > 0 ? discountPercent : null,
    inStock: bool(winner.inStock),
    stockStatus: int(winner.stockStatus),
    runningOutQuantity: int(winner.runningOutQuantity),
    tags,
    campaign:
      campaign && idStr(campaign.id) ? { id: String(campaign.id), name: str(campaign.name) } : null,
  };
}

function readVariants(
  raw: unknown,
  sellerItems: ReadonlySet<string>,
): TrendyolVariantObservation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    const o = obj(v) ?? {};
    const barcode = str(o.barcode) ?? idStr(o.barcode);
    const itemNumber = idStr(o.itemNumber);
    return {
      itemNumber,
      label: str(o.value) ?? str(o.beautifiedValue),
      barcode,
      gtin14: gtin14(barcode),
      priceKurus: layer(o.price),
      inStock: bool(o.inStock),
      isSelected: o.isSelected === true,
      sellerScoped: itemNumber != null && sellerItems.has(itemNumber),
    };
  });
}

function readJsonLd(nodes: Json[]): TrendyolProductPageObservation["jsonLd"] {
  const node = nodes.find((n) => {
    const t = n["@type"];
    return t === "Product" || t === "ProductGroup";
  });
  if (!node) return null;
  const offer = obj(Array.isArray(node.offers) ? node.offers[0] : node.offers);
  const currency = currencyOf(offer?.priceCurrency);
  const siblings = Array.isArray(node.hasVariant)
    ? node.hasVariant
        .map((v) => {
          const o = obj(v) ?? {};
          const contentId = idStr(o.sku);
          const off = obj(o.offers);
          return contentId
            ? {
                contentId,
                priceKurus:
                  currencyOf(off?.priceCurrency) === "TRY" || !off?.priceCurrency
                    ? amountToKurus(off?.price)
                    : null,
              }
            : null;
        })
        .filter((s): s is { contentId: string; priceKurus: number | null } => s != null)
    : [];
  return {
    type: String(node["@type"]),
    priceKurus: currency ? amountToKurus(offer?.price ?? offer?.lowPrice) : null,
    currency,
    availability: availability(offer?.availability),
    groupSiblings: siblings,
  };
}

export function extractTrendyolProductPage(input: PageInputs): TrendyolProductPageObservation {
  const shared = obj(findWindowJson(input.scriptTexts, "__envoy__SHARED_PROPS"));
  const product = obj(shared?.product);
  const listing = obj(product?.merchantListing);
  const merchant = obj(listing?.merchant);
  const ldNodes = parseJsonLd(input.jsonLdTexts);
  const jsonLd = readJsonLd(ldNodes);
  const ldNode = ldNodes.find((n) => n["@type"] === "Product" || n["@type"] === "ProductGroup");
  const sideOther = obj(findWindowJson(input.scriptTexts, "__envoy_side-other-seller__PROPS"));

  // Gomulu veri adresteki urune mi ait? (sayfa ici gezinmede eski urunun verisi kalabilir)
  const pageContentId = contentIdOf(canonicalProductUrl(input.url));
  const embeddedIds = [
    idStr(product?.id),
    contentIdOf(canonicalProductUrl(ldNode?.["@id"])),
  ].filter((x): x is string => x != null);
  if (pageContentId && embeddedIds.some((id) => id !== pageContentId)) {
    return emptyObservation(input.observedAt);
  }

  const url = canonicalProductUrl(ldNode?.["@id"]) ?? canonicalProductUrl(input.url);
  const contentId = idStr(product?.id) ?? contentIdOf(url) ?? idStr(ldNode?.sku);
  const brand = str(obj(product?.brand)?.name) ?? str(obj(ldNode?.brand)?.name);
  const name = str(product?.name);
  // SSR adi markasizdir ("iPhone 16 Pro 128GB Çöl Titanyum"); JSON-LD adi markalidir.
  const title = str(ldNode?.name) ?? (name ? [brand, name].filter(Boolean).join(" ") : null);
  const ldImages = obj(ldNode?.image)?.contentUrl;
  const images = (
    Array.isArray(product?.images) ? product.images : Array.isArray(ldImages) ? ldImages : []
  ).filter((u): u is string => typeof u === "string" && u.startsWith("https://"));
  const sellerId = idStr(merchant?.id);
  const offer = readOffer(obj(listing?.winnerVariant), obj(listing?.campaign));
  const sellerItems = new Set(
    (Array.isArray(listing?.variants) ? listing.variants : [])
      .map((v) => idStr(obj(v)?.itemNumber))
      .filter((x): x is string => x != null),
  );
  const winnerItem = offer?.itemNumber;
  if (winnerItem) sellerItems.add(winnerItem);
  const variants = readVariants(product?.variants, sellerItems);

  const discounted = offer?.prices.discounted ?? null;
  const missing: string[] = [];
  if (!title) missing.push("title");
  if (discounted == null && jsonLd?.priceKurus == null) missing.push("price");
  if (images.length === 0) missing.push("image");
  if (!sellerId) missing.push("seller");
  if (variants.length === 0) missing.push("variants");
  if (offer?.inStock == null && (jsonLd?.availability ?? "unknown") === "unknown") {
    missing.push("stock");
  }
  if (!url) missing.push("url");

  return {
    kind: "trendyol-product-page",
    source: product ? "ssr-shared-props" : "json-ld-only",
    observedAt: input.observedAt,
    url,
    contentId,
    groupId: idStr(product?.productGroupId),
    title,
    brand,
    category: str(obj(product?.category)?.name),
    images,
    seller: sellerId ? { id: sellerId, name: str(merchant?.name) } : null,
    offer,
    variants,
    jsonLd,
    otherMerchantCount: int(sideOther?.otherMerchantCount),
    jsonLdMatchesDiscounted:
      discounted != null && jsonLd?.priceKurus != null ? discounted === jsonLd.priceKurus : null,
    staleEmbeddedData: false,
    missing,
  };
}

function emptyObservation(observedAt: string): TrendyolProductPageObservation {
  return {
    kind: "trendyol-product-page",
    source: "ssr-shared-props",
    observedAt,
    url: null,
    contentId: null,
    groupId: null,
    title: null,
    brand: null,
    category: null,
    images: [],
    seller: null,
    offer: null,
    variants: [],
    jsonLd: null,
    otherMerchantCount: null,
    jsonLdMatchesDiscounted: null,
    staleEmbeddedData: true,
    missing: ["title", "price", "image", "seller", "variants", "stock", "url"],
  };
}
