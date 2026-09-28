import { DEFAULT_REDIRECT_PATH, safeRedirectPath } from "@arilla/core";
import type { cookies } from "next/headers";

/**
 * Giriş sonrası dönüş yolu (`next`), sağlayıcıya gidip gelirken kısa ömürlü
 * httpOnly çerezde taşınır. Yazarken ve okurken iki kez `safeRedirectPath`
 * ile süzülür: çerez elle değiştirilse de dış adrese gidilmez.
 *
 * `SameSite=None; Secure`: Apple callback'i siteler arası POST'tur ve Lax
 * çerez o istekte gönderilmez (bkz. `apple/route.ts`). `path=/giris`
 * Google, Apple ve telefon adımlarının hepsini kapsar.
 */
export const AUTH_NEXT_COOKIE = "auth_next";
const AUTH_NEXT_PATH = "/giris";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/** Güvenli ve varsayılandan farklıysa yazar; değilse eski değeri siler. */
export function rememberAuthNext(store: CookieStore, raw: unknown): void {
  const next = safeRedirectPath(raw);
  if (next === DEFAULT_REDIRECT_PATH) {
    store.delete({ name: AUTH_NEXT_COOKIE, path: AUTH_NEXT_PATH });
    return;
  }
  store.set(AUTH_NEXT_COOKIE, next, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: AUTH_NEXT_PATH,
    maxAge: 15 * 60,
  });
}

/** Okur, siler ve güvenli yolu döndürür (yoksa `/`). */
export function takeAuthNext(store: CookieStore): string {
  const next = safeRedirectPath(store.get(AUTH_NEXT_COOKIE)?.value);
  store.delete({ name: AUTH_NEXT_COOKIE, path: AUTH_NEXT_PATH });
  return next;
}
