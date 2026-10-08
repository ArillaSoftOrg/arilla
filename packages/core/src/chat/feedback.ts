/**
 * Sohbet geri bildirimi: neden/yorum dogrulamasi ve oran siniri (docs/decisions/0079).
 *
 * Saf fonksiyonlar; veritabani yazimi `service.ts` icindeki `setResultFeedback`tadir.
 * Olumlu oy neden/yorum tasimaz; olumsuz oyda ikisi de istege baglidir.
 */
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { cleanFormText, formTextLength } from "../feedback/validate.ts";
import { incrementFixedWindow } from "../redis/counter.ts";

export const CHAT_FEEDBACK_REASONS = [
  "not_found",
  "irrelevant",
  "misunderstood",
  "wrong_info",
  "wrong_price_or_product",
  "slow",
  "other",
] as const;
export type ChatFeedbackReason = (typeof CHAT_FEEDBACK_REASONS)[number];

export const CHAT_FEEDBACK_COMMENT_MAX = 500;
/** Arayuz tek neden sunar; dizi cok secime hazir (karar 0079 m.3). */
export const CHAT_FEEDBACK_MAX_REASONS = 3;

export const CHAT_FEEDBACK_WINDOW_SECONDS = 10 * 60;
export const CHAT_FEEDBACK_MAX_WRITES = 30;

export type ChatFeedbackDetails =
  | { ok: true; reasons: ChatFeedbackReason[]; comment: string | null }
  | { ok: false };

function isReason(value: unknown): value is ChatFeedbackReason {
  return typeof value === "string" && (CHAT_FEEDBACK_REASONS as readonly string[]).includes(value);
}

/**
 * Olumlu oyda neden/yorum verilirse reddedilir (istemci hatasi); olumsuzda temizlenir,
 * tekrarlar atilir, bos yorum NULL olur.
 */
export function validateChatFeedback(input: {
  helpful: unknown;
  reasons?: unknown;
  comment?: unknown;
}): ChatFeedbackDetails {
  if (typeof input.helpful !== "boolean") return { ok: false };
  const rawReasons = input.reasons ?? [];
  if (!Array.isArray(rawReasons)) return { ok: false };
  if (input.comment !== undefined && input.comment !== null && typeof input.comment !== "string") {
    return { ok: false };
  }
  const reasons = [...new Set(rawReasons)];
  if (!reasons.every(isReason) || reasons.length > CHAT_FEEDBACK_MAX_REASONS) return { ok: false };
  const comment = cleanFormText(typeof input.comment === "string" ? input.comment : "");
  if (formTextLength(comment) > CHAT_FEEDBACK_COMMENT_MAX) return { ok: false };
  if (input.helpful) {
    return reasons.length === 0 && comment === ""
      ? { ok: true, reasons: [], comment: null }
      : { ok: false };
  }
  return { ok: true, reasons, comment: comment === "" ? null : comment };
}

export function chatFeedbackRateLimitKey(userId: number): string {
  return `chat_fb:user:${userId}`;
}

/** `true`: yazima izin var. Redis erisilemezse `RedisUnavailableError` firlar (fail-closed). */
export async function consumeChatFeedbackQuota(
  userId: number,
  increment: FixedWindowCounter = incrementFixedWindow,
): Promise<boolean> {
  const count = await increment(chatFeedbackRateLimitKey(userId), CHAT_FEEDBACK_WINDOW_SECONDS);
  return count <= CHAT_FEEDBACK_MAX_WRITES;
}
