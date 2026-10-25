/**
 * Hangi giris saglayicisi su an kullanilabilir - yalnizca yapilandirmaya
 * bakar, aga cikmaz. Giris ekranlari bununla yapilandirilmamis saglayiciyi
 * "su an kullanilamiyor" olarak gosterir; kullanici bozuk bir akisa
 * gonderilmez. Baslangic route'lari ayrica ayni kontrolu yapar (dogrudan
 * adresle gelen de Google/Apple'a gonderilmez).
 *
 * `email` (karar 0150): e-posta + sifre girisi. SMTP (host/port/kimlik/EMAIL_FROM)
 * ve Argon2id (Node >= 24.7) hazir degilse giris ekrani secenegi gostermez;
 * dogrulama e-postasi gidemeyecek bir kayit akisina kullanici sokulmaz.
 */
import { smtpConfigFromEnv } from "../email/transport.ts";
import { appleConfigFromEnv } from "./apple-oauth.ts";
import { googleConfigFromEnv } from "./google-flow.ts";
import { isPasswordHashingAvailable } from "./password-hash.ts";
import { getSmsSender } from "./sms.ts";

export interface AuthProviderAvailability {
  google: boolean;
  apple: boolean;
  phone: boolean;
  /** 0150: e-posta + sifre. */
  email: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

function succeeds(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

export function authProviderAvailability(env: Env = process.env): AuthProviderAvailability {
  return {
    google: succeeds(() => googleConfigFromEnv(env)),
    apple: succeeds(() => appleConfigFromEnv(env)),
    // Gelistirmede saglayici bos ise konsol gondericisi; production'da
    // SMS_PROVIDER + NETGSM_* eksikse kullanilamaz (sms.ts, fail-closed).
    phone: succeeds(() => getSmsSender(env)),
    email: succeeds(() => {
      smtpConfigFromEnv(env);
      if (!env.EMAIL_FROM?.trim()) throw new Error("EMAIL_FROM yok");
      if (!isPasswordHashingAvailable()) throw new Error("argon2 yok");
    }),
  };
}
