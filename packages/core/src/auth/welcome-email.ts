/**
 * Hos geldin e-postasi (karar 0151): yalnizca hesabin ILK olusturuldugu girisin
 * sonucunda (`isNewUser`), islem commit olduktan sonra, en iyi cabayla gonderilir.
 *
 * - Mevcut hesapla eslesen giris (ornegin Google ile ayni e-posta) `isNewUser:
 *   false` doner; tekrar girislerde de gonderilmez.
 * - Gecmise donuk toplu gonderim yoktur: tetikleyici yalnizca giris yolundadir.
 * - Dogrulanmamis adrese ve Apple gizli aktarma adresine gonderilmez (gizli
 *   aktarma, kayitli alan adi olmadan iletiyi dusurur ve gonderen itibarini bozar).
 * - Gonderim hatasi girisi bozmaz (`sendCredentialNoticeBestEffort`).
 * - Tek seferlik garanti icin ek tablo/migration yok: kesin-bir-kez degil,
 *   en-fazla-bir-kez (cokmede ileti kaybolabilir, ikinci kez gonderilmez).
 */
import { requireAppUrl } from "../config/app-url.ts";
import { isApplePrivateRelayEmail } from "./email-address.ts";
import { sendCredentialNoticeBestEffort } from "./send-credential-email.ts";

export async function sendWelcomeEmailIfNewAccount(result: {
  isNewUser: boolean;
  user: { email: string | null };
  emailVerified: boolean;
}): Promise<void> {
  const email = result.user.email?.trim().toLowerCase();
  if (!result.isNewUser || !result.emailVerified || !email) return;
  if (isApplePrivateRelayEmail(email)) return;
  try {
    await sendCredentialNoticeBestEffort({ kind: "welcome", email, url: requireAppUrl() });
  } catch {
    // APP_URL cozumlenemedi: giris etkilenmez.
  }
}
