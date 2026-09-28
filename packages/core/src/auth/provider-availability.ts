/**
 * Hangi giris saglayicisi su an kullanilabilir - yalnizca yapilandirmaya
 * bakar, aga cikmaz. Giris ekranlari bununla yapilandirilmamis saglayiciyi
 * "su an kullanilamiyor" olarak gosterir; kullanici bozuk bir akisa
 * gonderilmez. Baslangic route'lari ayrica ayni kontrolu yapar (dogrudan
 * adresle gelen de Google/Apple'a gonderilmez).
 *
 * E-posta bu listede yok: SMTP hatasi giris formunda zaten "gonderemedik"
 * olarak gosterilir.
 */
import { appleConfigFromEnv } from "./apple-oauth.ts";
import { googleConfigFromEnv } from "./google-flow.ts";
import { getSmsSender } from "./sms.ts";

export interface AuthProviderAvailability {
  google: boolean;
  apple: boolean;
  phone: boolean;
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
  };
}
