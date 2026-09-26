"use server";

import {
  acceptAll,
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  type CookieConsent,
  fromSelection,
  OPTIONAL_CONSENT_CATEGORIES,
  OPTIONAL_COOKIES,
  rejectAll,
  serializeConsent,
} from "@arilla/core/cookie-consent";
import { cookies } from "next/headers";

/**
 * Karar 0038: cerez tercihi birinci taraf `cookie_consent` cerezine yazilir
 * (`theme-actions.ts` deseni). Form action olarak kullanilir; JS kapaliyken
 * de calisir. Server action cerez yazinca Next mevcut rotayi yeniden
 * render eder, kok layout yeni tercihi okur ve banner kalkar.
 */
async function persist(consent: CookieConsent): Promise<void> {
  const store = await cookies();
  store.set(CONSENT_COOKIE_NAME, serializeConsent(consent), {
    path: "/",
    maxAge: CONSENT_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  // Riza geri cekilen kategorinin birinci taraf cerezleri silinir (legal pack 07 §5).
  for (const category of OPTIONAL_CONSENT_CATEGORIES) {
    if (consent[category]) continue;
    for (const name of OPTIONAL_COOKIES[category]) store.delete(name);
  }
}

export async function acceptAllCookiesAction(): Promise<void> {
  await persist(acceptAll());
}

export async function rejectAllCookiesAction(): Promise<void> {
  await persist(rejectAll());
}

/** Kutucuk isaretliyse tarayici `on` gonderir, degilse alan hic gelmez. */
export async function saveCookiePreferencesAction(formData: FormData): Promise<void> {
  await persist(
    fromSelection({
      functional: formData.get("functional") === "on",
      analytics: formData.get("analytics") === "on",
      marketing: formData.get("marketing") === "on",
    }),
  );
}
