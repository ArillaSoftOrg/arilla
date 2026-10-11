/**
 * Karar 0093: yuzen hizli arama kutusunun gorunurluk kurallari. Saf fonksiyonlar
 * (DOM yok); kaydirma/gozlem baglantisi `floating-composer-client.tsx`te.
 *
 * - Ana kutu gorunurken gizli.
 * - Ana kutu gorunmezken asagi kaydirma (en az `SHOW_DOWN_PX`) gosterir.
 * - Yukari en az `HIDE_UP_PX` kaydirma gizler; tekrar asagi kaydirma gosterir.
 * - Esik, yon degistigi noktadan olculur (histerezis: titreme yok).
 * - iOS lastik etkisi: konum [0, en alt] araligina kirpilir; sinir disi
 *   ziplama yon degisikligi sayilmaz.
 * - Odak/yazma suruyorsa kaydirma (mobil klavyenin gorunum degisikligi) gizlemez.
 * - Kapatildiysa sayfa omru boyunca gizli; cerez bandi varken gizli.
 */

export const SHOW_DOWN_PX = 8;
export const HIDE_UP_PX = 24;

export interface ScrollTrack {
  /** Kaydirmanin istedigi durum (diger kosullar ayrica uygulanir). */
  shown: boolean;
  lastY: number;
  /** Son yon degisikliginin oldugu konum. */
  anchorY: number;
  direction: "up" | "down" | null;
}

export function initialScrollTrack(y: number): ScrollTrack {
  return { shown: false, lastY: y, anchorY: y, direction: null };
}

/** Yeni kaydirma konumunu isler. `maxY`: belge en alt konumu (scrollHeight - innerHeight). */
export function trackScroll(state: ScrollTrack, rawY: number, maxY: number): ScrollTrack {
  const y = Math.min(Math.max(rawY, 0), Math.max(maxY, 0));
  const delta = y - state.lastY;
  if (delta === 0) return state;

  if (delta > 0) {
    const anchorY = state.direction === "down" ? state.anchorY : state.lastY;
    const shown = state.shown || y - anchorY >= SHOW_DOWN_PX;
    return { shown, lastY: y, anchorY, direction: "down" };
  }
  const anchorY = state.direction === "up" ? state.anchorY : state.lastY;
  const shown = state.shown && anchorY - y < HIDE_UP_PX;
  return { shown, lastY: y, anchorY, direction: "up" };
}

/** Ana kutu yeniden gorununce kaydirma durumu sifirlanir: tekrar asagi kaydirma gerekir. */
export function resetScrollTrack(state: ScrollTrack): ScrollTrack {
  return { shown: false, lastY: state.lastY, anchorY: state.lastY, direction: null };
}

export interface FloatingConditions {
  scrollShown: boolean;
  mainVisible: boolean;
  dismissed: boolean;
  bannerVisible: boolean;
  /** Odak hizli arama kutusunun icinde (yazma suruyor). */
  focused: boolean;
}

export function isFloatingVisible(c: FloatingConditions): boolean {
  if (c.dismissed || c.bannerVisible) return false;
  if (c.focused) return true;
  return !c.mainVisible && c.scrollShown;
}
