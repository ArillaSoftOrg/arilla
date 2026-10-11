/** Internet arama sonucu tipleri (docs/decisions/0102). Katalog verisi DEGILDIR. */

export type WebMatchKind = "exact" | "similar";
export type WebPriceStatus = "verified" | "unverified";

export interface WebOffer {
  /** Kanonik adresten turetilmis kararli kimlik. */
  id: string;
  /** Satici gosterim adi (ana makine adi, `www.` atilmis). */
  seller: string;
  host: string;
  /** Kanonik, guvenli https adresi; yonlendirme yalnizca imzali token ile. */
  url: string;
  title: string;
  /** Kurus. Yalnizca `priceStatus === "verified"` ise dolu. */
  priceKurus: number | null;
  priceStatus: WebPriceStatus;
  /** Yalnizca sayfa dogrulandiysa; aksi halde `null` (bilinmiyor). */
  inStock: boolean | null;
}

export interface WebProductGroup {
  key: string;
  title: string;
  brand: string | null;
  matchKind: WebMatchKind;
  offers: WebOffer[];
  /** Dogrulanmis en dusuk fiyat, kurus; yoksa `null`. */
  minVerifiedPriceKurus: number | null;
}

export type WebSearchStatus =
  | "ok"
  | "empty"
  | "disabled"
  | "ineligible"
  | "limited"
  | "busy"
  | "unavailable"
  | "error";

export interface WebSearchOutcome {
  status: WebSearchStatus;
  groups: WebProductGroup[];
  cached: boolean;
}

export interface WebSearchFeatures {
  brand: string | null;
  /** Harf + rakam karisik model kodlari (kucuk harf). */
  modelCodes: string[];
  colors: string[];
  capacities: string[];
  sizes: string[];
}

export function emptyWebOutcome(status: WebSearchStatus): WebSearchOutcome {
  return { status, groups: [], cached: false };
}
