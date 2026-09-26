import {
  CONSENT_COOKIE_NAME,
  type CookieConsent,
  parseConsentCookie,
} from "@arilla/core/cookie-consent";
import { cookies } from "next/headers";

/**
 * Karar 0038: sunucuda gecerli cerez tercihi. `null` = riza yok (veya eski
 * surum / bozuk deger): zorunlu olmayan hicbir sey calismaz. Sunucu tarafi
 * zorunlu olmayan olcum eklenirse ayni fonksiyonla kapilanir.
 */
export async function readConsent(): Promise<CookieConsent | null> {
  const store = await cookies();
  return parseConsentCookie(store.get(CONSENT_COOKIE_NAME)?.value);
}
