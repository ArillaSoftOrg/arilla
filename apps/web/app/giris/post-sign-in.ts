import { needsOnboarding, postAuthRedirect, type SessionUser } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/** İlk giriş karşılaması (karar 0059). Oturum gerektirir; ürün kapısından bağımsızdır. */
export const ONBOARDING_PATH = "/hos-geldin";

/**
 * Dört giriş yolunun ortak varış noktası: normal hesap ilk girişinde
 * (`onboarded_at` boş) karşılamaya gider, asıl hedef `next` olarak taşınır.
 * Personel (moderatör/yönetici) karşılamayı görmez. Karşılama durumu
 * okunamazsa giriş bozulmaz, normal hedefe gidilir.
 */
export async function postSignInDestination(
  user: Pick<SessionUser, "id" | "role">,
  next: unknown,
): Promise<string> {
  const target = postAuthRedirect(user, next);
  if (user.role !== "user" && user.role !== "creator") return target;
  try {
    if (await needsOnboarding(getDatabase(), user.id)) {
      return `${ONBOARDING_PATH}?next=${encodeURIComponent(target)}`;
    }
  } catch (error) {
    console.error(
      "[giris] onboarding check failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
  return target;
}
