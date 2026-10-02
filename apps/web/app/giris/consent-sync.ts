import { syncConsentOnSignIn } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { readConsent } from "../lib/consent.ts";

/**
 * Başarılı girişin sonunda çağrılır (docs/decisions/0049 §6): tarayıcıdaki
 * geçerli çerez kararı, hesapta daha yeni bir karar yoksa hesaba aktarılır;
 * giriş ekranında gösterilen gizlilik metninin sürümü kaydedilir.
 *
 * Apple callback'i siteler arası POST'tur; `SameSite=Lax` olan
 * `cookie_consent` o istekte gelmez. O zaman çerez senkronu hiçbir şey
 * yazmaz (izin varsayılmaz). Girişi asla bozmaz: hata yalnızca türüyle loglanır.
 */
export async function syncConsentAfterSignIn(userId: number): Promise<void> {
  try {
    await syncConsentOnSignIn(getDatabase(), { userId, cookie: await readConsent() });
  } catch (error) {
    console.error("[giris] consent sync failed", error instanceof Error ? error.name : "unknown");
  }
}
