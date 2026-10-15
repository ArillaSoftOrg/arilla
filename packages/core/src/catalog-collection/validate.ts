/**
 * Tarayicidan gelen kaydin SUNUCU tarafi dogrulamasi (karar 0117). Istemci
 * guvenilmez girdidir: her alan yeniden sinanir, bilinmeyen alan atilir,
 * eksik alan uydurulmaz.
 */
import { isRecord } from "./parse-helpers.ts";

export interface IntakeRecordInput {
  externalId: string;
  title: string;
  url: string;
  priceMinor: number;
  listPriceMinor: number | null;
  currency: "TRY";
  inStock: boolean | null;
  imageUrl: string | null;
  brand: string | null;
  categoryRaw: string | null;
  sellerExternalId: string | null;
  sellerName: string | null;
  variantLabel: string | null;
  gtin: string | null;
  foundVia: string | null;
  sourceObservedAt: Date;
  /** 0072 (karar 0118): yalniz `extended` kurali olan kaynakta dolar; digerlerinde null. */
  imageUrls: string[] | null;
  groupExternalId: string | null;
  variantExternalId: string | null;
  /** Sepette uygulanan kosullu fiyat; satis fiyati degildir. */
  basketPriceMinor: number | null;
  sourcePage: "search_page" | "product_page" | "listing_page" | null;
}

/** 100 milyon TL: ustu veri hatasi sayilir. */
export const MAX_PRICE_MINOR = 10_000_000_000;

export type RecordRejection =
  | "not_object"
  | "external_id"
  | "title"
  | "url"
  | "price"
  | "list_price"
  | "currency"
  | "image_url"
  | "observed_at"
  | "gtin"
  | "image_urls"
  | "basket_price"
  | "variant"
  | "group"
  | "source_page";

export interface ValidationRules {
  urlHost: string;
  imageHost: string;
  now: Date;
  runStart: Date;
  /** Kaynak kimligi bicimi (varsayilan: harf/rakam/_/-, 2-200). */
  externalIdPattern?: RegExp;
  /** Adres kaynak kimligiyle tutarli kanonik urun adresi mi (Trendyol: `-p-<contentId>`). */
  canonicalUrl?: (url: string, externalId: string) => boolean;
  /** 0072 alanlari (coklu gorsel, satici adi, grup, varyant, sepet fiyati, sayfa turu) kabul edilir. */
  extended?: boolean;
}

function hostOk(raw: string, suffix: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (u.hostname === suffix || u.hostname.endsWith(`.${suffix}`))
    );
  } catch {
    return false;
  }
}

function optText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function validPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_PRICE_MINOR;
}

export function validateIntakeRecord(
  raw: unknown,
  rules: ValidationRules,
): { ok: true; record: IntakeRecordInput } | { ok: false; code: RecordRejection } {
  if (!isRecord(raw)) return { ok: false, code: "not_object" };
  const externalId = optText(raw.externalId, 200);
  if (!(externalId && (rules.externalIdPattern ?? /^[A-Za-z0-9_-]{2,200}$/).test(externalId))) {
    return { ok: false, code: "external_id" };
  }
  const title = optText(raw.title, 500);
  if (!title) return { ok: false, code: "title" };
  const url = typeof raw.url === "string" ? raw.url : "";
  if (url.length > 2048 || !hostOk(url, rules.urlHost)) return { ok: false, code: "url" };
  if (rules.canonicalUrl && !rules.canonicalUrl(url, externalId)) return { ok: false, code: "url" };
  if (!validPrice(raw.priceMinor)) return { ok: false, code: "price" };
  const priceMinor = raw.priceMinor;
  let listPriceMinor: number | null = null;
  if (raw.listPriceMinor != null) {
    if (!validPrice(raw.listPriceMinor)) return { ok: false, code: "list_price" };
    // Satis fiyatindan buyuk olmayan liste fiyati indirim bilgisi degildir.
    listPriceMinor = raw.listPriceMinor > priceMinor ? raw.listPriceMinor : null;
  }
  if (raw.currency !== "TRY") return { ok: false, code: "currency" };
  let imageUrl: string | null = null;
  if (raw.imageUrl != null) {
    if (
      typeof raw.imageUrl !== "string" ||
      raw.imageUrl.length > 2048 ||
      !hostOk(raw.imageUrl, rules.imageHost)
    ) {
      return { ok: false, code: "image_url" };
    }
    imageUrl = raw.imageUrl;
  }
  const observed = new Date(
    typeof raw.sourceObservedAt === "string" ? raw.sourceObservedAt : Number.NaN,
  );
  const slack = 5 * 60_000;
  if (
    Number.isNaN(observed.getTime()) ||
    observed.getTime() < rules.runStart.getTime() - slack ||
    observed.getTime() > rules.now.getTime() + slack
  ) {
    return { ok: false, code: "observed_at" };
  }
  const gtin = optText(raw.gtin, 14);
  if (gtin && !/^[0-9]{8,14}$/.test(gtin)) return { ok: false, code: "gtin" };
  const ext = rules.extended ? extendedFields(raw, priceMinor, rules.imageHost) : NO_EXTENDED;
  if ("code" in ext) return { ok: false, code: ext.code };
  return {
    ok: true,
    record: {
      externalId,
      title,
      url: url.split(/[?#]/)[0] as string,
      priceMinor,
      listPriceMinor,
      currency: "TRY",
      inStock: typeof raw.inStock === "boolean" ? raw.inStock : null,
      imageUrl,
      brand: optText(raw.brand, 200),
      categoryRaw: optText(raw.categoryRaw, 500),
      sellerExternalId: optText(raw.sellerExternalId, 200),
      sellerName: optText(raw.sellerName, 300),
      variantLabel: optText(raw.variantLabel, 200),
      gtin,
      foundVia: optText(raw.foundVia, 200),
      sourceObservedAt: observed,
      ...ext,
    },
  };
}

type Extended = Pick<
  IntakeRecordInput,
  | "imageUrls"
  | "groupExternalId"
  | "variantExternalId"
  | "basketPriceMinor"
  | "sourcePage"
>;

const NO_EXTENDED: Extended = {
  imageUrls: null,
  groupExternalId: null,
  variantExternalId: null,
  basketPriceMinor: null,
  sourcePage: null,
};

const SOURCE_PAGES = new Set(["search_page", "product_page", "listing_page"]);

function extendedFields(
  raw: Record<string, unknown>,
  priceMinor: number,
  imageHost: string,
): Extended | { code: RecordRejection } {
  let imageUrls: string[] | null = null;
  if (raw.imageUrls != null) {
    if (!Array.isArray(raw.imageUrls) || raw.imageUrls.length > 6) return { code: "image_urls" };
    const list = raw.imageUrls.filter(
      (u): u is string => typeof u === "string" && u.length <= 2048 && hostOk(u, imageHost),
    );
    if (list.length !== raw.imageUrls.length) return { code: "image_urls" };
    imageUrls = list.length > 0 ? [...new Set(list)] : null;
  }
  let basketPriceMinor: number | null = null;
  if (raw.basketPriceMinor != null) {
    if (!validPrice(raw.basketPriceMinor)) return { code: "basket_price" };
    // Satis fiyatindan dusuk olmayan "sepet fiyati" indirim bilgisi degildir.
    basketPriceMinor = raw.basketPriceMinor < priceMinor ? raw.basketPriceMinor : null;
  }
  const groupExternalId = optText(raw.groupExternalId, 20);
  if (groupExternalId && !/^[0-9]{1,20}$/.test(groupExternalId)) return { code: "group" };
  const variantExternalId = optText(raw.variantExternalId, 100);
  if (variantExternalId && !/^[0-9A-Za-z_-]{1,100}$/.test(variantExternalId)) {
    return { code: "variant" };
  }
  const sourcePage = raw.sourcePage == null ? null : String(raw.sourcePage);
  if (sourcePage != null && !SOURCE_PAGES.has(sourcePage)) return { code: "source_page" };
  return {
    imageUrls,
    groupExternalId,
    variantExternalId,
    basketPriceMinor,
    sourcePage: sourcePage as Extended["sourcePage"],
  };
}
