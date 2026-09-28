/**
 * Yonetim oturumu politikasi (P3, docs/decisions/0044). Normal kullanici
 * oturumu (90 gun) DEGISMEZ; ayni `session` satiri yonetim alaninda daha
 * siki kurallarla degerlendirilir:
 *
 * - En uzun omur: giristen itibaren 12 saat (`ADMIN_SESSION_MAX_AGE_MS`).
 * - Bosta kalma: son istekten itibaren 30 dakika (`ADMIN_IDLE_TIMEOUT_MS`).
 *   `last_used_at` her dogrulanmis istekte guncellenir; karar ONCEKI deger
 *   uzerinden verilir.
 * - Taze giris: yuksek etkili mutasyonlar giristen itibaren 1 saat
 *   (`FRESH_AUTH_MAX_AGE_MS`) icinde yapilmali.
 *
 * Rol her istekte veritabanindan okunur (`verifySessionToken`); rolu dusurulen
 * kisi bir sonraki yonetim isteginde erisimi kaybeder. Bu dosya saf
 * fonksiyonlardan ibarettir; yonlendirme `apps/web/app/lib/dal.ts`'te.
 */
import { safeRedirectPath } from "../auth/safe-redirect.ts";

export const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const FRESH_AUTH_MAX_AGE_MS = 60 * 60 * 1000;

export const ADMIN_HOME_PATH = "/yonetim";
/**
 * Ayri yonetim giris ekrani. (`access/product-access.ts` `ADMIN_LOGIN_PATH`
 * ise karar 0043 geregi "Admin Girisi" baglantisidir: `/giris?next=/yonetim`.)
 */
export const ADMIN_LOGIN_PAGE_PATH = "/yonetim/giris";

export type AdminSessionState = "ok" | "expired" | "idle";

export function evaluateAdminSession(
  session: { createdAt?: Date; lastUsedAt?: Date },
  now: Date = new Date(),
): AdminSessionState {
  // Zaman bilgisi olmayan oturum guvenli tarafta kalir: yeniden giris.
  if (!session.createdAt) return "expired";
  if (now.getTime() - session.createdAt.getTime() > ADMIN_SESSION_MAX_AGE_MS) return "expired";
  if (session.lastUsedAt && now.getTime() - session.lastUsedAt.getTime() > ADMIN_IDLE_TIMEOUT_MS) {
    return "idle";
  }
  return "ok";
}

export function isFreshAuth(createdAt: Date | undefined, now: Date = new Date()): boolean {
  return createdAt !== undefined && now.getTime() - createdAt.getTime() <= FRESH_AUTH_MAX_AGE_MS;
}

export function isAdminPath(path: string): boolean {
  return path === ADMIN_HOME_PATH || path.startsWith(`${ADMIN_HOME_PATH}/`);
}

/** Yonetim girisi sonrasi hedef: yalnizca guvenli bir `/yonetim` yolu, degilse `/yonetim`. */
export function safeAdminNext(raw: unknown): string {
  const path = safeRedirectPath(raw);
  return isAdminPath(path) ? path : ADMIN_HOME_PATH;
}

/** Yeniden giris nedeni (`/yonetim/giris?neden=`): kullaniciya aciklama icin. */
export type AdminLoginReason = "sure" | "bosta" | "yeniden";

export function adminLoginPath(next: unknown, reason?: AdminLoginReason): string {
  const params = new URLSearchParams();
  const target = safeAdminNext(next);
  if (target !== ADMIN_HOME_PATH) params.set("next", target);
  if (reason) params.set("neden", reason);
  const query = params.toString();
  return query ? `${ADMIN_LOGIN_PAGE_PATH}?${query}` : ADMIN_LOGIN_PAGE_PATH;
}
