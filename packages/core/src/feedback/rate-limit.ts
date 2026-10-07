/**
 * Geri bildirim oran siniri: 10 dakikada 5 gonderim (docs/decisions/0045).
 * Giris oran siniri (`auth/rate-limit.ts`) ile ayni sabit pencereli sayac
 * (`redis/counter.ts`) ve ayni paylasilan Redis baglantisi.
 *
 * Anahtar: girisliyse `feedback:user:<id>` (oturumdan), anonimse IP ozeti.
 * IP `resolveClientIp` ile cozulur (istemcinin yazabildigi
 * `x-forwarded-for` basina guvenilmez) ve SHA-256 ile ozetlenir - Redis'te
 * duz IP birakilmaz. IP cozulemezse anonim gonderimler ortak bir kovayi
 * paylasir: sinirsiz yazma yolu acilmaz.
 *
 * Redis erisilemezse `RedisUnavailableError` firlar; cagiran gonderimi
 * yazmaz (fail-closed).
 */
import { createHash } from "node:crypto";
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { incrementFixedWindow } from "../redis/counter.ts";

export const FEEDBACK_WINDOW_SECONDS = 10 * 60;
export const FEEDBACK_MAX_SUBMISSIONS = 5;

export function feedbackRateLimitKey(input: { userId: number | null; ip: string | null }): string {
  if (input.userId !== null) return `feedback:user:${input.userId}`;
  if (input.ip) {
    return `feedback:ip:${createHash("sha256").update(input.ip.trim()).digest("hex")}`;
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
