/**
 * Karar 0092: elle secilen tema tercihi. Sunucu (kok layout) cerezi okuyup
 * `<html data-theme>` yazar; ilk boyama dogru temada gelir (inline betik,
 * localStorage yok). Cerez yoksa `data-theme` da yoktur ve tema cihaz
 * tercihinden (`prefers-color-scheme`) gelir.
 *
 * Saf modul: hem sunucu hem istemci kullanir (next/headers icermez).
 */

export type Theme = "light" | "dark";

/** Zorunlu cerez (docs/kvkk.md "Zorunlu çerezler": tema tercihi). */
export const THEME_COOKIE = "theme";
/** Bir yil; secim yenilendikce uzar. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Yalnizca bilinen iki deger; diger her sey "elle secim yok" sayilir. */
export function parseTheme(value: string | null | undefined): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function oppositeTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/**
 * `document.cookie` atamasi. HttpOnly degil: istemci secimi sunucuya gidip
 * sayfayi yeniden cizdirmeden aninda yazar; deger yalnizca "light"/"dark"dir,
 * kimlik ya da kisisel veri tasimaz.
 */
export function themeCookieAssignment(theme: Theme, options: { secure: boolean }): string {
  return [
    `${THEME_COOKIE}=${theme}`,
    "Path=/",
    `Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}
