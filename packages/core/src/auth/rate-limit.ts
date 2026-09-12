/**
 * decision 0006 madde 2: e-posta ve IP basina oran siniri. Esikler B4'teki
 * gibi bir kalibrasyon setinden gelmiyor - makul varsayilan, urun-kritik bir
 * karar degil, `docs/decisions/` altina yazilmiyor.
 */
import { getRedis } from "../redis/client.ts";

const EMAIL_WINDOW_SECONDS = 60;
const EMAIL_MAX_REQUESTS = 1;
const IP_WINDOW_SECONDS = 60 * 60;
const IP_MAX_REQUESTS = 10;

export class RateLimitExceededError extends Error {
  constructor(scope: "email" | "ip") {
    super(`giris istegi oran sinirina takildi: ${scope}`);
    this.name = "RateLimitExceededError";
  }
}

async function checkWindow(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const redis = getRedis();
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= max;
}

/**
 * Her ikisi de kontrol edilir; hangisi once asilirsa o scope ile hata
 * firlatilir. E-posta hash'lenmez - anahtar Redis'te, Postgres'te degil,
 * ve `docs/kvkk.md` bu tabloyu kisisel veri envanterine almiyor.
 */
export async function checkAuthRateLimit(input: {
  email: string;
  ip: string | null;
}): Promise<void> {
  const emailKey = `ratelimit:auth:email:${input.email.toLowerCase()}`;
  const emailOk = await checkWindow(emailKey, EMAIL_WINDOW_SECONDS, EMAIL_MAX_REQUESTS);
  if (!emailOk) {
    throw new RateLimitExceededError("email");
  }

  if (input.ip) {
    const ipKey = `ratelimit:auth:ip:${input.ip}`;
    const ipOk = await checkWindow(ipKey, IP_WINDOW_SECONDS, IP_MAX_REQUESTS);
    if (!ipOk) {
      throw new RateLimitExceededError("ip");
    }
  }
}
