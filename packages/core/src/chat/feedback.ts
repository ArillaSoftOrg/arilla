/**
 * Sohbet geri bildirimi: neden/yorum dogrulamasi ve oran siniri (docs/decisions/0079).
 *
 * Dogrulama ve oran siniri saftir; veritabani yazimi `service.ts` icindeki
 * `setResultFeedback`tadir. Saklama temizligi (yorum 90 gun) burada.
 * Olumlu oy neden/yorum tasimaz; olumsuz oyda ikisi de istege baglidir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
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

/** Yorum bu sureden sonra silinir; oy ve neden istatistigi kalir (karar 0079 m.8). */
export const CHAT_FEEDBACK_COMMENT_RETENTION_DAYS = 90;

export interface FeedbackCommentPurgeResult {
  cleared: number;
  truncated: boolean;
}

/** Eski serbest metin yorumlari NULL'a ceker. Parti parti; `updated_at` degismez. */
export async function purgeExpiredFeedbackComments(
  db: Database,
  now: Date = new Date(),
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<FeedbackCommentPurgeResult> {
  const batchSize = options.batchSize ?? 2_000;
  const maxBatches = options.maxBatches ?? 20;
  const cutoff = new Date(now.getTime() - CHAT_FEEDBACK_COMMENT_RETENTION_DAYS * 86_400_000);
  let cleared = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.execute(sql`
      UPDATE chat_result_feedback SET comment = NULL
       WHERE message_id IN (
         SELECT message_id FROM chat_result_feedback
          WHERE comment IS NOT NULL AND updated_at < ${cutoff.toISOString()}::timestamptz
          ORDER BY updated_at
          LIMIT ${batchSize}
       )
    `);
    const count = result.rowCount ?? 0;
    cleared += count;
    if (count < batchSize) return { cleared, truncated: false };
  }
  return { cleared, truncated: true };
}

/** Gunluk temizlikte digerlerinden yalitilir; hata yalnizca sinif + SQL koduyla loglanir. */
export async function purgeExpiredFeedbackCommentsSafely(
  db: Database,
  now: Date = new Date(),
): Promise<FeedbackCommentPurgeResult & { failed: string | null }> {
  try {
    return { ...(await purgeExpiredFeedbackComments(db, now)), failed: null };
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
      (error as { code?: string })?.code ??
      "error";
    console.warn(
      "[sohbet] feedback comment retention failed",
      error instanceof Error ? error.name : "unknown",
      code,
    );
    return { cleared: 0, truncated: false, failed: /^[0-9A-Z]{5}$/.test(code) ? code : "error" };
  }
}
