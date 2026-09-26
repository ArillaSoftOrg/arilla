/**
 * decision 0006 madde 2: e-posta ve IP basina oran siniri. Esikler B4'teki
 * gibi bir kalibrasyon setinden gelmiyor - makul varsayilan, urun-kritik bir
 * karar degil, `docs/decisions/` altina yazilmiyor.
 *
 * Redis erisilemezse `RedisUnavailableError` firlatir; oran siniri
 * dogrulanamadigi icin giris istegi de gonderilmez (fail-closed).
 */
import { createHash } from "node:crypto";
import { getRedis } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";

const EMAIL_WINDOW_SECONDS = 60;
const EMAIL_MAX_REQUESTS = 1;
const IP_WINDOW_SECONDS = 60 * 60;
const IP_MAX_REQUESTS = 10;

export class RateLimitExceededError extends Error {
  constructor(scope: "email" | "ip" | "phone") {
    super(`giris istegi oran sinirina takildi: ${scope}`);
    this.name = "RateLimitExceededError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * E-posta ve IP anahtara duz yazilmaz - Redis'te (izleme araclari, `KEYS`
 * ciktisi, yedekler) kisisel veri birakmamak icin SHA-256 ile ozetlenir.
 * Eski duz anahtarlar en fazla 1 saatlik TTL ile kendiliginden silinir.
 */
export function authRateLimitKeys(input: { email: string; ip: string | null }): {
  emailKey: string;
  ipKey: string | null;
} {
  return {
    emailKey: `ratelimit:auth:email:${digest(input.email.trim().toLowerCase())}`,
    ipKey: input.ip ? `ratelimit:auth:ip:${digest(input.ip.trim())}` : null,
  };
}

/**
 * E-posta gonderilemediyse o adresin 60 saniyelik hakki geri verilir: aksi
 * halde kullanici hemen tekrar denediginde "Az önce bir bağlantı gönderdik"
 * gorur - gonderilmemis bir e-posta icin yanlis bir iddia. IP sayaci geri
 * alinmaz (kotuye kullanim siniri korunur). En iyi caba: Redis de
 * erisilemezse sessizce gecilir, asil hata cagirana zaten iletilmistir.
 */
export async function releaseEmailRateLimit(email: string): Promise<void> {
  const { emailKey } = authRateLimitKeys({ email, ip: null });
  try {
    await getRedis().del(emailKey);
  } catch {
    // en iyi caba
  }
}

/** Her ikisi de kontrol edilir; hangisi once asilirsa o scope ile hata firlatilir. */
export async function checkAuthRateLimit(input: {
  email: string;
  ip: string | null;
}): Promise<void> {
  const { emailKey, ipKey } = authRateLimitKeys(input);

  const emailCount = await incrementFixedWindow(emailKey, EMAIL_WINDOW_SECONDS);
  if (emailCount > EMAIL_MAX_REQUESTS) {
    throw new RateLimitExceededError("email");
  }

  if (ipKey) {
    const ipCount = await incrementFixedWindow(ipKey, IP_WINDOW_SECONDS);
    if (ipCount > IP_MAX_REQUESTS) {
      throw new RateLimitExceededError("ip");
    }
  }
}
