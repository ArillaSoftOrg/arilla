import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE, type Theme } from "./theme.ts";

/**
 * Karar 0092: sunucuda elle secilen tema. `null` = elle secim yok, tema cihaz
 * tercihinden gelir. `readConsent` (lib/consent.ts) ile ayni ince sarmalayici.
 */
export async function readThemePreference(): Promise<Theme | null> {
  const store = await cookies();
  return parseTheme(store.get(THEME_COOKIE)?.value);
}
