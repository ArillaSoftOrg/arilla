/**
 * Trendyol: yoneticinin KENDI tarayicisinda acilmis sayfadan katalog kaydi cikarma (karar 0118).
 *
 * EK AG ISTEGI YOKTUR. Girdi, acik sayfada zaten bulunan metinlerdir (`collectTrendyolPageInputs`
 * DOM'dan toplar; eklentinin icerik betigi cagirir). Tarayiciya paketlenir: yalnizca
 * `parse-helpers`e baglidir.
 *
 * Kaynaklar (kayitli ornekler ve tek normal ziyaretle dogrulandi, research/trendyol-landing-discovery 16):
 *  - Urun sayfasi: `window["__envoy__SHARED_PROPS"].product` (+ JSON-LD yalniz kanonik adres/ad icin).
 *  - Liste sayfasi: `window["__single-search-result__PROPS"].data.products` (ilk ~36 kart).
 *
 * FIYAT KURALI (sepet indirimi satis fiyatiyla KARISTIRILMAZ):
 *  - `priceMinor` = SATIS fiyati: urun sayfasinda `winnerVariant.price.sellingPrice`, listede `price.current`.
 *  - `basketPriceMinor` = sepette uygulanan KOSULLU fiyat (`discountedPrice`), yalniz satis fiyatindan
 *    dusukse ve (listede) `binaryPrice.discountType === "basketPromotion"` ise. Bilgi amaclidir.
 *  - `listPriceMinor` = ustu cizili fiyat, yalniz satis fiyatindan yuksekse.
 *  - JSON-LD `offers.price` SATIS FIYATI DEGILDIR (sepet fiyatina esit olabilir; Samba 3.999,50 / 7.999).
 *  - Satis fiyati okunamazsa kayit URETILMEZ (fiyat uydurulmaz); `dropped.price_unverified` sayilir.
 *
 * ALINMAYANLAR: diger saticilarin teklifleri, stok, saticinin kisisel/kurumsal bilgileri (vergi no,
 * KEP, adres, unvan), yorumlar, ozellik listeleri. Satici icin yalniz `id` ve `name`.
 */
import { decimalToKurus, isRecord } from "./parse-helpers.ts";

export const TRENDYOL_ORIGIN = "https://www.trendyol.com";
const PRODUCT_KEY = "__envoy__SHARED_PROPS";
const LISTING_KEY = "__single-search-result__PROPS";
const MAX_IMAGES = 6;

export interface TrendyolPageInputs {
  url: string;
  /** Sayfanin okundugu an (ISO). Kaynak zamani olarak tasinir. */
  observedAt: string;
  scriptTexts: readonly string[];
  jsonLdTexts: readonly string[];
}

export type TrendyolSourcePage = "product_page" | "listing_page";

export interface TrendyolIntakeItem {
  externalId: string;
  title: string;
  url: string;
  priceMinor: number;
  listPriceMinor: number | null;
  basketPriceMinor: number | null;
  currency: "TRY";
  imageUrl: string | null;
  imageUrls: string[];
  brand: string | null;
  categoryRaw: string | null;
  sellerExternalId: string | null;
  sellerName: string | null;
  groupExternalId: string | null;
  variantExternalId: string | null;
  variantLabel: string | null;
  sourcePage: TrendyolSourcePage;
  sourceObservedAt: string;
}

export type DropReason =
  | "no_content_id"
  | "no_title"
  | "price_unverified"
  | "not_try"
  | "stale_embedded_data";

export interface TrendyolExtractedPage {
  kind: TrendyolSourcePage | "unknown";
  /** Kapsam birimi anahtari: urun sayfasinda contentId, listede yol. */
  unitKey: string | null;
  items: TrendyolIntakeItem[];
  /** Sayfadaki ham urun sayisi (gecersizler dahil). */
  rawCount: number;
  /** Beklenen yapi bulundu mu (engel/dogrulama sayfasi ya da yapi degisimi icin false). */
  structureFound: boolean;
  dropped: Partial<Record<DropReason, number>>;
}

type Json = Record<string, unknown>;

interface ScriptLike {
  readonly type: string;
  readonly textContent: string | null;
}

/** Icerik betigi icin: sayfanin satir ici betik metinleri (izole dunyadan okunabilir). */
export function collectTrendyolPageInputs(
  doc: { querySelectorAll(selector: "script"): ArrayLike<ScriptLike> },
  url: string,
  observedAt: string,
): TrendyolPageInputs {
  const scripts = Array.from(doc.querySelectorAll("script"));
  return {
    url,
    observedAt,
    scriptTexts: scripts
      .filter((s) => !s.type || s.type === "text/javascript")
      .map((s) => s.textContent ?? ""),
    jsonLdTexts: scripts
      .filter((s) => s.type === "application/ld+json")
      .map((s) => s.textContent ?? ""),
  };
}

/** Kayitli HTML'den ayni girdi (testler/kuru calisma). */
export function trendyolInputsFromHtml(
  html: string,
  url: string,
  observedAt: string,
): TrendyolPageInputs {
  const scriptTexts: string[] = [];
  const jsonLdTexts: string[] = [];
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const type = /\btype\s*=\s*"([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "";
    if (type === "application/ld+json") jsonLdTexts.push(m[2] ?? "");
    else if (!type || type === "text/javascript") scriptTexts.push(m[2] ?? "");
  }
  return { url, observedAt, scriptTexts, jsonLdTexts };
}

function windowJson(scriptTexts: readonly string[], key: string): unknown {
  const marker = `window["${key}"]=`;
  for (const text of scriptTexts) {
    const i = text.indexOf(marker);
    if (i < 0) continue;
    try {
      return JSON.parse(
        text
          .slice(i + marker.length)
          .trim()
          .replace(/;\s*$/, ""),
      );
    } catch {
      return null;
    }
  }
  return null;
}

const obj = (v: unknown): Json | null => (isRecord(v) ? v : null);
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const digits = (v: unknown): string | null =>
  (typeof v === "number" || typeof v === "string") && /^[0-9]{1,20}$/.test(String(v))
    ? String(v)
    : null;

/** `{value, text}` ya da sayi -> kurus. */
const money = (v: unknown): number | null => decimalToKurus(obj(v) ? (v as Json).value : v);

/** Kanonik urun adresi: `https://www.trendyol.com/<marka>/<slug>-p-<contentId>` (sorgu yok). */
export function canonicalTrendyolProductUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw, TRENDYOL_ORIGIN);
    if (u.origin !== TRENDYOL_ORIGIN || !/^\/[^/]+\/[^/]+-p-[0-9]{1,20}$/.test(u.pathname)) {
      return null;
    }
    return `${TRENDYOL_ORIGIN}${u.pathname}`;
  } catch {
    return null;
  }
}

const contentIdOf = (url: string | null) => url?.match(/-p-([0-9]{1,20})$/)?.[1] ?? null;

/** Liste/arama sayfasi yolu (filtre `-x-`, arama terimi `-y-s<id>`, `/sr`); degilse null. */
export function isTrendyolListingPath(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.origin !== TRENDYOL_ORIGIN) return null;
    const p = u.pathname;
    return /^\/[^/]+-x-[^/]+$/.test(p) || /^\/[^/]+-y-s[0-9]+$/.test(p) || p === "/sr"
      ? p.slice(0, 200)
      : null;
  } catch {
    return null;
  }
}

function imagesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    try {
      const u = new URL(raw);
      if (
        u.protocol === "https:" &&
        (u.hostname === "dsmcdn.com" || u.hostname.endsWith(".dsmcdn.com"))
      ) {
        if (!out.includes(u.toString())) out.push(u.toString());
      }
    } catch {}
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function pricing(
  selling: number | null,
  original: number | null,
  discounted: number | null,
  basketSignal: boolean,
): { priceMinor: number; listPriceMinor: number | null; basketPriceMinor: number | null } | null {
  if (selling == null) return null;
  return {
    priceMinor: selling,
    listPriceMinor: original != null && original > selling ? original : null,
    basketPriceMinor:
      basketSignal && discounted != null && discounted < selling ? discounted : null,
  };
}

const currencyOk = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "TRY" || s === "TL";
};

function bump(d: Partial<Record<DropReason, number>>, r: DropReason) {
  d[r] = (d[r] ?? 0) + 1;
}

function productLdNode(jsonLdTexts: readonly string[]): Json | null {
  for (const t of jsonLdTexts) {
    try {
      const parsed: unknown = JSON.parse(t);
      for (const n of Array.isArray(parsed) ? parsed : [parsed]) {
        const o = obj(n);
        if (o && (o["@type"] === "Product" || o["@type"] === "ProductGroup")) return o;
      }
    } catch {}
  }
  return null;
}

function extractProductPage(input: TrendyolPageInputs, shared: Json): TrendyolExtractedPage {
  const dropped: Partial<Record<DropReason, number>> = {};
  const product = obj(shared.product);
  const page = (items: TrendyolIntakeItem[], unitKey: string | null): TrendyolExtractedPage => ({
    kind: "product_page",
    unitKey,
    items,
    rawCount: product ? 1 : 0,
    structureFound: product != null,
    dropped,
  });
  if (!product) return page([], contentIdOf(canonicalTrendyolProductUrl(input.url)));

  const ld = productLdNode(input.jsonLdTexts);
  const pageUrl = canonicalTrendyolProductUrl(input.url);
  const pageId = contentIdOf(pageUrl);
  const productId = digits(product.id);
  const ldUrl = canonicalTrendyolProductUrl(ld?.["@id"]);
  // Sayfa ici gezinmede gomulu veri onceki urune ait kalabilir: adresle eslesmezse kullanilmaz.
  if (pageId && ((productId && productId !== pageId) || (ldUrl && contentIdOf(ldUrl) !== pageId))) {
    bump(dropped, "stale_embedded_data");
    return page([], pageId);
  }
  const contentId = productId ?? pageId;
  if (!contentId) {
    bump(dropped, "no_content_id");
    return page([], null);
  }
  const url = ldUrl ?? pageUrl ?? null;
  const brand = text(obj(product.brand)?.name, 200);
  const name = text(product.name, 400);
  const title = text(ld?.name, 500) ?? (name ? [brand, name].filter(Boolean).join(" ") : null);
  if (!title || !url) {
    bump(dropped, title ? "no_content_id" : "no_title");
    return page([], contentId);
  }
  const listing = obj(product.merchantListing);
  const winner = obj(listing?.winnerVariant);
  const price = obj(winner?.price);
  if (price && !currencyOk(price.currency)) {
    bump(dropped, "not_try");
    return page([], contentId);
  }
  const selling = money(price?.sellingPrice);
  const discounted = money(price?.discountedPrice);
  // Urun sayfasinda indirimli fiyat satis fiyatindan dusukse bu sepet/promosyon kosuludur
  // (dogrudan indirimde Trendyol satis fiyatini dusurur: selling == discounted).
  const p = pricing(selling, money(price?.originalPrice), discounted, true);
  if (!p) {
    bump(dropped, "price_unverified");
    return page([], contentId);
  }
  const merchant = obj(listing?.merchant);
  const sellerVariants = Array.isArray(listing?.variants) ? listing.variants : [];
  const winnerItem = digits(winner?.itemNumber);
  const selected = sellerVariants.map(obj).find((v) => v && digits(v.itemNumber) === winnerItem);
  const label = text(selected?.value, 100);
  const images = imagesOf(product.images);
  return page(
    [
      {
        externalId: contentId,
        title,
        url,
        ...p,
        currency: "TRY",
        imageUrl: images[0] ?? null,
        imageUrls: images,
        brand,
        categoryRaw: text(obj(product.category)?.name, 500),
        sellerExternalId: digits(merchant?.id),
        sellerName: text(merchant?.name, 200),
        groupExternalId: digits(product.productGroupId),
        // Fiyat bedene gore degisebildigi icin fiyatin ait oldugu varyant tasinir. Tek varyantli
        // urunde Trendyol etiketi bos gelir (iPhone: value ""); o zaman alan bos kalir.
        variantExternalId: label ? winnerItem : null,
        variantLabel: label,
        sourcePage: "product_page",
        sourceObservedAt: input.observedAt,
      },
    ],
    contentId,
  );
}

function extractListingPage(input: TrendyolPageInputs, props: Json): TrendyolExtractedPage {
  const dropped: Partial<Record<DropReason, number>> = {};
  const products = obj(props.data)?.products;
  let unitKey: string | null = null;
  try {
    unitKey = new URL(input.url).pathname.slice(0, 200) || null;
  } catch {}
  if (!Array.isArray(products)) {
    return {
      kind: "listing_page",
      unitKey,
      items: [],
      rawCount: 0,
      structureFound: false,
      dropped,
    };
  }
  const items: TrendyolIntakeItem[] = [];
  const seen = new Set<string>();
  for (const raw of products) {
    const c = obj(raw);
    const url = canonicalTrendyolProductUrl(c?.url);
    const contentId = contentIdOf(url) ?? digits(c?.contentId);
    if (!c || !url || !contentId) {
      bump(dropped, "no_content_id");
      continue;
    }
    const brand = text(c.brand, 200);
    const name = text(c.name, 400);
    if (!name) {
      bump(dropped, "no_title");
      continue;
    }
    const price = obj(c.price);
    if (price?.currency != null && !currencyOk(price.currency)) {
      bump(dropped, "not_try");
      continue;
    }
    const basket = obj(c.binaryPrice)?.discountType === "basketPromotion";
    const p = pricing(
      money(price?.current),
      money(price?.originalPrice),
      money(price?.discountedPrice),
      basket,
    );
    if (!p) {
      bump(dropped, "price_unverified");
      continue;
    }
    if (seen.has(contentId)) continue;
    seen.add(contentId);
    const images = imagesOf([c.image, ...(Array.isArray(c.images) ? c.images : [])]);
    const variant = text(c.variantValue, 100);
    items.push({
      externalId: contentId,
      title: [brand, name].filter(Boolean).join(" "),
      url,
      ...p,
      currency: "TRY",
      imageUrl: images[0] ?? null,
      imageUrls: images,
      brand,
      categoryRaw: text(obj(c.category)?.name, 500),
      sellerExternalId: digits(c.merchantId),
      // Liste karti satici adini tasimaz; uydurulmaz.
      sellerName: null,
      groupExternalId: digits(c.groupId),
      variantExternalId: c.isOneSize === true ? null : digits(c.itemNumber),
      variantLabel: c.isOneSize === true ? null : variant,
      sourcePage: "listing_page",
      sourceObservedAt: input.observedAt,
    });
  }
  return {
    kind: "listing_page",
    unitKey,
    items,
    rawCount: products.length,
    structureFound: true,
    dropped,
  };
}

/** Acik Trendyol sayfasindan kayitlar. Sayfa turu gomulu veriden anlasilir. */
export function extractTrendyolPage(input: TrendyolPageInputs): TrendyolExtractedPage {
  try {
    if (new URL(input.url).origin !== TRENDYOL_ORIGIN) {
      return {
        kind: "unknown",
        unitKey: null,
        items: [],
        rawCount: 0,
        structureFound: false,
        dropped: {},
      };
    }
  } catch {
    return {
      kind: "unknown",
      unitKey: null,
      items: [],
      rawCount: 0,
      structureFound: false,
      dropped: {},
    };
  }
  const shared = obj(windowJson(input.scriptTexts, PRODUCT_KEY));
  if (shared?.product) return extractProductPage(input, shared);
  const listing = obj(windowJson(input.scriptTexts, LISTING_KEY));
  if (listing) return extractListingPage(input, listing);
  // Beklenen yapi yok: urun/liste adresindeyse bu bir engel ya da yapi degisimidir (kosu durur);
  // baska sayfalar (ana sayfa vb.) toplama birimi degildir.
  const productUrl = canonicalTrendyolProductUrl(input.url);
  const listingUrl = isTrendyolListingPath(input.url);
  return {
    kind: productUrl ? "product_page" : listingUrl ? "listing_page" : "unknown",
    unitKey: productUrl ? contentIdOf(productUrl) : listingUrl,
    items: [],
    rawCount: 0,
    structureFound: false,
    dropped: {},
  };
}
