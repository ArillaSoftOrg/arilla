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
  gtin: string | null;
  foundVia: string | null;
  sourceObservedAt: Date;
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
  | "gtin";

export interface ValidationRules {
  urlHost: string;
  imageHost: string;
  now: Date;
  runStart: Date;
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
  if (!(externalId && /^[A-Za-z0-9_-]{2,200}$/.test(externalId))) {
    return { ok: false, code: "external_id" };
  }
  const title = optText(raw.title, 500);
  if (!title) return { ok: false, code: "title" };
  const url = typeof raw.url === "string" ? raw.url : "";
  if (url.length > 2048 || !hostOk(url, rules.urlHost)) return { ok: false, code: "url" };
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
      gtin,
      foundVia: optText(raw.foundVia, 200),
      sourceObservedAt: observed,
    },
  };
}
