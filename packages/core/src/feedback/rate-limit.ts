/**
 * Geri bildirim oran siniri: 10 dakikada 5 gonderim (docs/decisions/0045).
 * Giris oran siniri (`auth/rate-limit.ts`) ile ayni sabit pencereli sayac
 * (`redis/counter.ts`) ve ayni paylasilan Redis baglantisi.
 *
 * Anahtar: girisliyse `feedback:user:<id>` (oturumdan), anonimse IP ozeti.
 * IP `resolveClientIp` ile cozulur (istemcinin yazabildigi
 * `x-forwarded-for` basina guvenilmez) ve `SESSION_SECRET` ile HMAC-SHA256
 * (`pseudonymize`) takma adlandirilir - Redis'te duz IP birakilmaz, ozet sirsiz
 * geri cevrilemez. Sir tanimsizsa `SecretNotConfiguredError` firlar (fail-closed). IP cozulemezse anonim gonderimler ortak bir kovayi
 * paylasir: sinirsiz yazma yolu acilmaz.
 *
 * Redis erisilemezse `RedisUnavailableError` firlar; cagiran gonderimi
 * yazmaz (fail-closed).
 */
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { pseudonymize } from "../auth/token.ts";
import { incrementFixedWindow } from "../redis/counter.ts";

export const FEEDBACK_WINDOW_SECONDS = 10 * 60;
export const FEEDBACK_MAX_SUBMISSIONS = 5;

export function feedbackRateLimitKey(input: { userId: number | null; ip: string | null }): string {
  if (input.userId !== null) return `feedback:user:${input.userId}`;
  if (input.ip) {
    return `feedback:ip:${pseudonymize("feedback", input.ip.trim())}`;
  }
  return "feedback:ip:unknown";
}

/** `true`: gonderime izin var. Sayac her cagrida bir artar. */
export async function consumeFeedbackQuota(
  input: { userId: number | null; ip: string | null },
  increment: FixedWindowCounter = incrementFixedWindow,
): Promise<boolean> {
  const count = await increment(feedbackRateLimitKey(input), FEEDBACK_WINDOW_SECONDS);
  return count <= FEEDBACK_MAX_SUBMISSIONS;
}
