/**
 * Form gonderim oran siniri (docs/decisions/0058). Mevcut sabit pencereli
 * Redis sayaci (`redis/counter.ts`); yeni istemci yok. Redis erisilemezse
 * `RedisUnavailableError` firlar, cagiran gonderimi yazmaz (fail-closed).
 *
 * - Girisli: `forms:user:<userId>:<formId>` 10 dakikada 10 gonderim.
 * - Anonim: `forms:ip:<ozet>:<formId>` 10 dakikada 5 gonderim. IP
 *   `resolveClientIp` ile cozulur ve HMAC-SHA256 ile takma adlandirilir
 *   (`pseudonymize`; sir tanimsizsa fail-closed); cozulemezse
 *   ortak kova (sinirsiz yazma yolu acilmaz).
 * - Anonim + tek yanitli form: ek olarak IP ozeti basina gunde 3 gonderim.
 *   Anonim kimlik garantisi yoktur; ortak IP (mobil operator NAT) arkasindaki
 *   gercek kullanicilari kilitlememek icin tavan 1 degil 3'tur.
 */
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { pseudonymize } from "../auth/token.ts";
import { incrementFixedWindow } from "../redis/counter.ts";

export const FORM_WINDOW_SECONDS = 10 * 60;
export const FORM_USER_MAX = 10;
export const FORM_ANON_MAX = 5;
export const FORM_ANON_SINGLE_DAILY_MAX = 3;
const DAY_SECONDS = 24 * 60 * 60;

function ipDigest(ip: string | null): string {
  return ip ? pseudonymize("forms", ip.trim()) : "unknown";
}

export function formRateLimitKey(input: {
  formId: number;
  userId: number | null;
  ip: string | null;
}): string {
  if (input.userId !== null) return `forms:user:${input.userId}:${input.formId}`;
  return `forms:ip:${ipDigest(input.ip)}:${input.formId}`;
}

/** `true`: gonderime izin var. Sayac her cagrida artar. */
export async function consumeFormQuota(
  input: { formId: number; userId: number | null; ip: string | null; singleResponse: boolean },
  increment: FixedWindowCounter = incrementFixedWindow,
): Promise<boolean> {
  const key = formRateLimitKey(input);
  const count = await increment(key, FORM_WINDOW_SECONDS);
  const max = input.userId !== null ? FORM_USER_MAX : FORM_ANON_MAX;
  if (count > max) return false;
  if (input.userId === null && input.singleResponse) {
    const daily = await increment(`forms:ipday:${ipDigest(input.ip)}:${input.formId}`, DAY_SECONDS);
    if (daily > FORM_ANON_SINGLE_DAILY_MAX) return false;
  }
  return true;
}
