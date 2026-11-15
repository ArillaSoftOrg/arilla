/**
 * Değerlendirme metni için AYRI geri bildirim (karar 0202; tablo `chat_explanation_feedback`,
 * migration 0116). Ürün sonuçlarının oyu (`chat_result_feedback`, karar 0075/0079) değişmez; iki oy
 * bağımsız kaydedilir ve ölçülür. Doğrulama saf; yazma burada, sahiplik sorguda.
 *
 * Tablo yoksa (kod, migration'dan önce dağıtıldıysa) `unavailable` döner: sohbet ve sonuç oyu
 * etkilenmez.
 */
import { chatExplanationFeedback, chatMessage, conversation, type Database } from "@arilla/db";
import { and, eq, sql } from "drizzle-orm";
import { cleanFormText, formTextLength } from "../feedback/validate.ts";
import { CHAT_FEEDBACK_COMMENT_MAX, CHAT_FEEDBACK_MAX_REASONS } from "./feedback.ts";
import { isUuid } from "./service.ts";

export const EXPLANATION_FEEDBACK_REASONS = [
  "inaccurate",
  "unclear",
  "irrelevant",
  "other",
] as const;
export type ExplanationFeedbackReason = (typeof EXPLANATION_FEEDBACK_REASONS)[number];

export type ExplanationFeedbackDetails =
  | { ok: true; reasons: ExplanationFeedbackReason[]; comment: string | null }
  | { ok: false };

function isReason(value: unknown): value is ExplanationFeedbackReason {
  return (
    typeof value === "string" && (EXPLANATION_FEEDBACK_REASONS as readonly string[]).includes(value)
  );
}

/** `validateChatFeedback` ile aynı kurallar, açıklamaya özgü neden kodlarıyla. */
export function validateExplanationFeedback(input: {
  helpful: unknown;
  reasons?: unknown;
  comment?: unknown;
}): ExplanationFeedbackDetails {
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

export type ExplanationFeedbackStatus = "saved" | "not_found" | "invalid" | "unavailable";

function isMissingRelation(error: unknown): boolean {
  const code =
    (error as { cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  return code === "42P01";
}

/**
 * Bir arama mesajının değerlendirme oyu. Sahiplik `conversation.user_id` ile sorguda; yalnızca
 * `assistant`/`search` mesajına oy verilir. Aynı içerikle tekrar satırı değiştirmez (idempotent).
 */
export async function setExplanationFeedback(
  db: Database,
  input: {
    userId: number;
    conversationId: string;
    messageSeq: number;
    helpful: boolean;
    reasons?: readonly string[];
    comment?: string | null;
  },
): Promise<ExplanationFeedbackStatus> {
  if (!isUuid(input.conversationId)) return "not_found";
  if (!Number.isInteger(input.messageSeq) || input.messageSeq < 1) return "invalid";
  const details = validateExplanationFeedback(input);
  if (!details.ok) return "invalid";
  const [message] = await db
    .select({ id: chatMessage.id, role: chatMessage.role, kind: chatMessage.kind })
    .from(chatMessage)
    .innerJoin(conversation, eq(conversation.id, chatMessage.conversationId))
    .where(
      and(
        eq(chatMessage.conversationId, input.conversationId),
        eq(chatMessage.seq, input.messageSeq),
        eq(conversation.userId, input.userId),
      ),
    );
  if (!message) return "not_found";
  if (message.role !== "assistant" || message.kind !== "search") return "invalid";
  try {
    await db
      .insert(chatExplanationFeedback)
      .values({
        messageId: message.id,
        conversationId: input.conversationId,
        helpful: input.helpful,
        reasons: details.reasons,
        comment: details.comment,
      })
      .onConflictDoUpdate({
        target: chatExplanationFeedback.messageId,
        set: {
          helpful: input.helpful,
          reasons: details.reasons,
          comment: details.comment,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${chatExplanationFeedback.helpful} IS DISTINCT FROM ${input.helpful}
          OR ${chatExplanationFeedback.reasons} IS DISTINCT FROM ${sql.raw("EXCLUDED.reasons")}
          OR ${chatExplanationFeedback.comment} IS DISTINCT FROM ${sql.raw("EXCLUDED.comment")}`,
      });
  } catch (error) {
    // Migration 0116 henüz uygulanmamış: oy kaydedilemez, sohbet etkilenmez.
    if (isMissingRelation(error)) return "unavailable";
    throw error;
  }
  return "saved";
}
