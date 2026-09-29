import { attachReferral, normalizeReferralCode } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import type { cookies } from "next/headers";

/**
 * Davet kodu (docs/decisions/0047 madde 9), `/davet/<kod>`'dan girisin
 * sonuna kadar httpOnly cerezde tasinir. `auth_next` ile ayni gerekce:
 * Apple callback'i siteler arasi POST'tur, Lax cerez o istekte gitmez
 * (`SameSite=None; Secure`). `path=/giris` butun giris adimlarini kapsar.
 *
 * Kod yalnizca bicim olarak dogrulanir; sahibi baglama aninda aranir.
 * Cerez kod disinda hicbir sey tasimaz.
 */
export const REFERRAL_COOKIE = "davet_kodu";
const REFERRAL_COOKIE_PATH = "/giris";
const REFERRAL_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export function rememberReferralCode(store: CookieStore, raw: unknown): boolean {
  const code = normalizeReferralCode(raw);
  if (!code) return false;
  store.set(REFERRAL_COOKIE, code, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: REFERRAL_COOKIE_PATH,
    maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
  });
  return true;
}

/**
 * Basarili girisin sonunda cagrilir. Yeni hesapsa davet baglanir; cerez her
 * durumda silinir (mevcut hesaba sonradan davet baglanmaz). Girisi asla
 * bozmaz: hata yalnizca sebep koduyla loglanir.
 */
export async function settleReferralAfterSignIn(
  store: CookieStore,
  result: { user: { id: number }; isNewUser: boolean },
): Promise<void> {
  const code = store.get(REFERRAL_COOKIE)?.value;
  if (!code) return;
  store.delete({ name: REFERRAL_COOKIE, path: REFERRAL_COOKIE_PATH });
  if (!result.isNewUser) return;
  try {
    await attachReferral(getDatabase(), { inviteeUserId: result.user.id, code });
  } catch (error) {
    console.error(
      "[giris] referral attach failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
