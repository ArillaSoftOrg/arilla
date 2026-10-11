/**
 * decision 0006 madde 2: e-posta ve IP basina oran siniri. Esikler B4'teki
 * gibi bir kalibrasyon setinden gelmiyor - makul varsayilan, urun-kritik bir
 * karar degil, `docs/decisions/` altina yazilmiyor.
 *
 * Redis erisilemezse `RedisUnavailableError` firlatir; oran siniri
 * dogrulanamadigi icin giris istegi de gonderilmez (fail-closed).
 */
import { getRedis } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";
import { pseudonymize } from "./token.ts";

const EMAIL_WINDOW_SECONDS = 60;
const EMAIL_MAX_REQUESTS = 1;
/**
 * Adres basina saatlik ve gunluk tavan: dakikalik sinir tek basina bir
 * adrese saatte 60 e-posta gonderilmesine izin veriyordu (farkli IP'lerden
 * e-posta bombardimani). Gercek kullanici icin 5/saat ve 10/gun fazlasiyla yeter.
 */
export const EMAIL_HOURLY_MAX_REQUESTS = 5;
export const EMAIL_DAILY_MAX_REQUESTS = 10;
const EMAIL_HOURLY_WINDOW_SECONDS = 60 * 60;
const EMAIL_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const IP_WINDOW_SECONDS = 60 * 60;
const IP_MAX_REQUESTS = 10;

/** Testte Redis'siz sayac enjekte edilebilsin diye; varsayilan `incrementFixedWindow`. */
export type FixedWindowCounter = (key: string, windowSeconds: number) => Promise<number>;

export class RateLimitExceededError extends Error {
  constructor(scope: "email" | "ip" | "phone") {
    super(`giris istegi oran sinirina takildi: ${scope}`);
    this.name = "RateLimitExceededError";
  }
}

function digest(value: string): string {
  return pseudonymize("auth", value);
}

/**
 * E-posta ve IP anahtara duz yazilmaz - Redis'te (izleme araclari, `KEYS`
 * ciktisi, yedekler) kisisel veri birakmamak icin HMAC-SHA256 ile takma
 * adlandirilir (`pseudonymize`; tuzsuz SHA-256 IPv4/e-posta uzayinda geri cevrilir).
 * Eski duz anahtarlar en fazla 1 saatlik TTL ile kendiliginden silinir.
 */
export function authRateLimitKeys(input: { email: string; ip: string | null }): {
  emailKey: string;
  emailHourlyKey: string;
  emailDailyKey: string;
  ipKey: string | null;
} {
  const emailDigest = digest(input.email.trim().toLowerCase());
  return {
    emailKey: `ratelimit:auth:email:${emailDigest}`,
    emailHourlyKey: `ratelimit:auth:email-hour:${emailDigest}`,
    emailDailyKey: `ratelimit:auth:email-day:${emailDigest}`,
    ipKey: input.ip ? `ratelimit:auth:ip:${digest(input.ip.trim())}` : null,
  };
}

/**
 * E-posta gonderilemediyse o adresin 60 saniyelik hakki geri verilir: aksi
 * halde kullanici hemen tekrar denediginde "Az önce bir bağlantı gönderdik"
 * gorur - gonderilmemis bir e-posta icin yanlis bir iddia. Saatlik ve
 * gunluk sayac da bir azaltilir. IP sayaci geri alinmaz (kotuye kullanim
 * siniri korunur). En iyi caba: Redis de erisilemezse sessizce gecilir,
 * asil hata cagirana zaten iletilmistir.
 */
export async function releaseEmailRateLimit(email: string): Promise<void> {
  const { emailKey, emailHourlyKey, emailDailyKey } = authRateLimitKeys({ email, ip: null });
  try {
    await getRedis().multi().del(emailKey).decr(emailHourlyKey).decr(emailDailyKey).exec();
  } catch {
    // en iyi caba
  }
}

/**
 * Sirayla: adres/dakika, adres/saat, adres/gun, IP/saat. Hangisi once
 * asilirsa o scope ile hata firlatilir. Redis yoksa `RedisUnavailableError`
 * (fail-closed); cagiran giris e-postasi gondermez.
 */
export async function checkAuthRateLimit(
  input: { email: string; ip: string | null },
  increment: FixedWindowCounter = incrementFixedWindow,
): Promise<void> {
  const { emailKey, emailHourlyKey, emailDailyKey, ipKey } = authRateLimitKeys(input);

  const emailWindows: [string, number, number][] = [
    [emailKey, EMAIL_WINDOW_SECONDS, EMAIL_MAX_REQUESTS],
    [emailHourlyKey, EMAIL_HOURLY_WINDOW_SECONDS, EMAIL_HOURLY_MAX_REQUESTS],
    [emailDailyKey, EMAIL_DAILY_WINDOW_SECONDS, EMAIL_DAILY_MAX_REQUESTS],
  ];
  for (const [key, windowSeconds, max] of emailWindows) {
    if ((await increment(key, windowSeconds)) > max) {
      throw new RateLimitExceededError("email");
    }
  }

  if (ipKey) {
    const ipCount = await increment(ipKey, IP_WINDOW_SECONDS);
    if (ipCount > IP_MAX_REQUESTS) {
      throw new RateLimitExceededError("ip");
    }
  }
}
