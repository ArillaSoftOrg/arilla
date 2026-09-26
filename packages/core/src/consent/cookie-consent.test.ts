import { describe, expect, it } from "vitest";
import {
  acceptAll,
  CONSENT_VERSION,
  fromSelection,
  isConsentAllowed,
  needsConsentPrompt,
  parseConsentCookie,
  rejectAll,
  serializeConsent,
} from "./cookie-consent.ts";

const NOW = new Date("2026-09-26T10:00:00.000Z");

describe("cerez rizasi", () => {
  it("riza yokken banner gosterilir ve zorunlu olmayan hicbir kategoriye izin yoktur", () => {
    expect(needsConsentPrompt(null)).toBe(true);
    expect(isConsentAllowed(null, "necessary")).toBe(true);
    expect(isConsentAllowed(null, "functional")).toBe(false);
    expect(isConsentAllowed(null, "analytics")).toBe(false);
    expect(isConsentAllowed(null, "marketing")).toBe(false);
  });

  it("Tumunu Reddet gerekli disindaki kategorileri false kaydeder", () => {
    const consent = rejectAll(NOW);
    expect(consent).toEqual({
      version: CONSENT_VERSION,
      necessary: true,
      functional: false,
      analytics: false,
      marketing: false,
      updatedAt: NOW.toISOString(),
    });
    expect(needsConsentPrompt(consent)).toBe(false);
  });

  it("Tumunu Kabul Et tum kategorileri true kaydeder", () => {
    const consent = acceptAll(NOW);
    expect(consent.functional && consent.analytics && consent.marketing).toBe(true);
    expect(isConsentAllowed(consent, "analytics")).toBe(true);
  });

  it("kategori bazli secim aynen kaydedilir", () => {
    const consent = fromSelection({ functional: true, analytics: false, marketing: true }, NOW);
    expect(isConsentAllowed(consent, "functional")).toBe(true);
    expect(isConsentAllowed(consent, "analytics")).toBe(false);
    expect(isConsentAllowed(consent, "marketing")).toBe(true);
  });

  it("serilestirilen tercih geri okununca korunur (sayfa yenileme)", () => {
    const consent = fromSelection({ functional: false, analytics: true, marketing: false }, NOW);
    expect(parseConsentCookie(serializeConsent(consent))).toEqual(consent);
    expect(parseConsentCookie(encodeURIComponent(serializeConsent(consent)))).toEqual(consent);
  });

  it("surum degisince eski tercih yok sayilir ve yeniden sorulur", () => {
    const stale = JSON.stringify({ ...acceptAll(NOW), version: CONSENT_VERSION - 1 });
    const parsed = parseConsentCookie(stale);
    expect(parsed).toBeNull();
    expect(needsConsentPrompt(parsed)).toBe(true);
    expect(isConsentAllowed(parsed, "analytics")).toBe(false);
  });

  it("bozuk veya eksik deger izin sayilmaz", () => {
    expect(parseConsentCookie(undefined)).toBeNull();
    expect(parseConsentCookie("")).toBeNull();
    expect(parseConsentCookie("evet")).toBeNull();
    expect(parseConsentCookie("null")).toBeNull();
    expect(parseConsentCookie(JSON.stringify({ ...acceptAll(NOW), analytics: "true" }))).toBeNull();
    expect(parseConsentCookie(JSON.stringify({ ...acceptAll(NOW), necessary: false }))).toBeNull();
    expect(parseConsentCookie(JSON.stringify({ ...acceptAll(NOW), updatedAt: "dun" }))).toBeNull();
  });
});
