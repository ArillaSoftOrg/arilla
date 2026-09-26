/**
 * Karar 0038: cerez rizasinin tek mantik kaynagi. Saf fonksiyonlar - Node
 * veya DB bagimliligi yok; istemci bilesenleri `@arilla/core/cookie-consent`
 * alt yolundan import eder (ana giris noktasi pg/ioredis ceker).
 *
 * Hesaba bagli rizalar (`user_consent`, account/consent.ts) ayri bir
 * konudur; bu modul yalnizca tarayicidaki cerez tercihini anlatir.
 */

/** Kategori veya politika degisince artirilir; eski surumlu cerez yok sayilir ve banner yeniden cikar. */
export const CONSENT_VERSION = 1;

export const CONSENT_COOKIE_NAME = "cookie_consent";

/** 12 ay. /cerez sayfasindaki envanterle ayni olmali. */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Zorunlu olmayan kategoriler - hepsi varsayilan olarak kapali. */
export const OPTIONAL_CONSENT_CATEGORIES = ["functional", "analytics", "marketing"] as const;

export type OptionalConsentCategory = (typeof OPTIONAL_CONSENT_CATEGORIES)[number];
export type ConsentCategory = "necessary" | OptionalConsentCategory;

/**
 * Kategori basina BIRINCI taraf zorunlu olmayan cerez adlari. Riza geri
 * cekilince tercih kaydeden action bunlari siler (legal pack 07 §5). Bugun
 * hepsi bos: sitede zorunlu olmayan cerez yok (denetim, 26 Eylul 2026).
 * Yeni bir teknoloji eklenince cerezi buraya VE /cerez envanterine yazilir.
 */
export const OPTIONAL_COOKIES: Readonly<Record<OptionalConsentCategory, readonly string[]>> = {
  functional: [],
  analytics: [],
  marketing: [],
};

export interface CookieConsent {
  version: number;
  necessary: true;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

export type ConsentSelection = Record<OptionalConsentCategory, boolean>;

export function fromSelection(selection: ConsentSelection, now: Date = new Date()): CookieConsent {
  return {
    version: CONSENT_VERSION,
    necessary: true,
    functional: selection.functional === true,
    analytics: selection.analytics === true,
    marketing: selection.marketing === true,
    updatedAt: now.toISOString(),
  };
}

export function acceptAll(now: Date = new Date()): CookieConsent {
  return fromSelection({ functional: true, analytics: true, marketing: true }, now);
}

export function rejectAll(now: Date = new Date()): CookieConsent {
  return fromSelection({ functional: false, analytics: false, marketing: false }, now);
}

export function serializeConsent(consent: CookieConsent): string {
  return JSON.stringify({
    version: consent.version,
    necessary: true,
    functional: consent.functional,
    analytics: consent.analytics,
    marketing: consent.marketing,
    updatedAt: consent.updatedAt,
  });
}

/**
 * Bozuk, eksik, bilinmeyen surumlu veya tip olarak hatali deger `null` doner
 * - yani "rıza yok": zorunlu olmayan hicbir sey calismaz ve banner yeniden
 * sorar. Supheli durumda izin varsayilmaz.
 */
export function parseConsentCookie(raw: string | undefined | null): CookieConsent | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    try {
      value = JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== CONSENT_VERSION) return null;
  if (record.necessary !== true) return null;
  for (const category of OPTIONAL_CONSENT_CATEGORIES) {
    if (typeof record[category] !== "boolean") return null;
  }
  if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) {
    return null;
  }
  return {
    version: CONSENT_VERSION,
    necessary: true,
    functional: record.functional as boolean,
    analytics: record.analytics as boolean,
    marketing: record.marketing as boolean,
    updatedAt: record.updatedAt,
  };
}

/** Gecerli, guncel surumlu bir tercih yoksa banner gosterilir. */
export function needsConsentPrompt(consent: CookieConsent | null): boolean {
  return consent === null || consent.version !== CONSENT_VERSION;
}

/** Zorunlu kategori her zaman acik; digerleri yalnizca acik izinle. */
export function isConsentAllowed(
  consent: CookieConsent | null,
  category: ConsentCategory,
): boolean {
  if (category === "necessary") return true;
  return consent?.[category] === true;
}
