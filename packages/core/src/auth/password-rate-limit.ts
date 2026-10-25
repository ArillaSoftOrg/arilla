/**
 * E-posta/sifre akisinin Redis destekli oran sinirlari (karar 0150).
 * Redis erisilemezse `RedisUnavailableError` firlar: sinir dogrulanamiyorsa
 * deneme/gonderim yapilmaz (fail-closed). Anahtarlarda e-posta/IP duz yazilmaz,
 * `pseudonymize` ile HMAC takma adi kullanilir.
 *
 * Giris: kaba kuvvete karsi uc katman - (e-posta + IP) cifti, e-posta basina
 * ve IP basina. Yalniz e-posta sayaci bir saldirganin baskasinin hesabini
 * kilitlemesine izin verirdi; bu yuzden e-posta tavani yuksek (saatte 20),
 * cift tavani dusuk (15 dakikada 5) tutulur.
 */
import { getRedis } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";
import {
  EMAIL_DAILY_MAX_REQUESTS,
  EMAIL_HOURLY_MAX_REQUESTS,
  type FixedWindowCounter,
  RateLimitExceededError,
} from "./rate-limit.ts";
import { pseudonymize } from "./token.ts";

export type EmailSendScope = "register" | "reset" | "resend";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const LOGIN_PAIR_WINDOW = 15 * MINUTE;
const LOGIN_PAIR_MAX = 5;
const LOGIN_EMAIL_WINDOW = HOUR;
const LOGIN_EMAIL_MAX = 20;
const LOGIN_IP_WINDOW = 15 * MINUTE;
const LOGIN_IP_MAX = 30;

const SEND_IP_WINDOW = HOUR;
const SEND_IP_MAX = 10;

const CHANGE_WINDOW = 15 * MINUTE;
const CHANGE_MAX = 5;

function digest(value: string): string {
  return pseudonymize("auth", value.trim().toLowerCase());
}

export function sendRateLimitKeys(
  scope: EmailSendScope,
  input: { email: string; ip: string | null },
) {
  const email = digest(input.email);
  return {
    minute: `ratelimit:cred:${scope}:email-min:${email}`,
    hour: `ratelimit:cred:${scope}:email-hour:${email}`,
    day: `ratelimit:cred:${scope}:email-day:${email}`,
    ip: input.ip ? `ratelimit:cred:${scope}:ip:${digest(input.ip)}` : null,
  };
}

/** Kayit/sifirlama/yeniden gonderim: adres basina dakika-saat-gun, IP basina saat tavani. */
export async function checkEmailSendRateLimit(
  scope: EmailSendScope,
  input: { email: string; ip: string | null },
  increment: FixedWindowCounter = incrementFixedWindow,
): Promise<void> {
  const keys = sendRateLimitKeys(scope, input);
  const windows: [string, number, number][] = [
    [keys.minute, MINUTE, 1],
    [keys.hour, HOUR, EMAIL_HOURLY_MAX_REQUESTS],
    [keys.day, DAY, EMAIL_DAILY_MAX_REQUESTS],
  ];
  for (const [key, seconds, max] of windows) {
    if ((await increment(key, seconds)) > max) throw new RateLimitExceededError("email");
  }
  if (keys.ip && (await increment(keys.ip, SEND_IP_WINDOW)) > SEND_IP_MAX) {
    throw new RateLimitExceededError("ip");
  }
}

/** Gonderilemeyen e-posta icin adres hakki geri verilir (IP sayaci geri alinmaz). */
export async function releaseEmailSendRateLimit(
  scope: EmailSendScope,
  email: string,
): Promise<void> {
  const keys = sendRateLimitKeys(scope, { email, ip: null });
  try {
    await getRedis().multi().del(keys.minute).decr(keys.hour).decr(keys.day).exec();
  } catch {
    // en iyi caba
  }
}

export function loginRateLimitKeys(input: { email: string; ip: string | null }) {
  const email = digest(input.email);
  return {
    pair: input.ip ? `ratelimit:cred:login:pair:${email}:${digest(input.ip)}` : null,
    email: `ratelimit:cred:login:email:${email}`,
    ip: input.ip ? `ratelimit:cred:login:ip:${digest(input.ip)}` : null,
  };
}

/** Her giris denemesi (basarili ya da degil) sayilir; asilirsa parola hic denenmez. */
export async function checkLoginRateLimit(
  input: { email: string; ip: string | null },
  increment: FixedWindowCounter = incrementFixedWindow,
): Promise<void> {
  const keys = loginRateLimitKeys(input);
  if (keys.ip && (await increment(keys.ip, LOGIN_IP_WINDOW)) > LOGIN_IP_MAX) {
    throw new RateLimitExceededError("ip");
  }
  if (keys.pair && (await increment(keys.pair, LOGIN_PAIR_WINDOW)) > LOGIN_PAIR_MAX) {
    throw new RateLimitExceededError("login");
  }
  if ((await increment(keys.email, LOGIN_EMAIL_WINDOW)) > LOGIN_EMAIL_MAX) {
    throw new RateLimitExceededError("login");
  }
}

/** Oturum acik kullanicinin mevcut sifre denemeleri: kullanici basina 15 dakikada 5. */
export async function checkPasswordChangeRateLimit(
  userId: number,
  increment: FixedWindowCounter = incrementFixedWindow,
): Promise<void> {
  const key = `ratelimit:cred:change:user:${pseudonymize("auth", String(userId))}`;
  if ((await increment(key, CHANGE_WINDOW)) > CHANGE_MAX) {
    throw new RateLimitExceededError("login");
  }
}
