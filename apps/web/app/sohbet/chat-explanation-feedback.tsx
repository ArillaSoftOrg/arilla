"use client";

import { useState, useTransition } from "react";
import { submitExplanationFeedbackAction } from "./actions.ts";
import { CHAT_COPY } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

const REASONS: { code: "inaccurate" | "unclear" | "irrelevant" | "other"; label: string }[] = [
  { code: "inaccurate", label: CHAT_COPY.explainReasonInaccurate },
  { code: "unclear", label: CHAT_COPY.explainReasonUnclear },
  { code: "irrelevant", label: CHAT_COPY.explainReasonIrrelevant },
  { code: "other", label: CHAT_COPY.explainReasonOther },
];

/**
 * Değerlendirme metninin altındaki AYRI oy (karar 0202): ürün sonuçlarının oyundan bağımsız.
 * Beğendim tek tıkla kaydedilir; Beğenmedim önce oyu kaydeder, ardından isteğe bağlı neden
 * seçenekleri sunar (seçim aynı oyu nedenle günceller). Hata olursa önceki değere dönülür.
 */
export function ExplanationFeedback({
  conversationId,
  messageSeq,
  initial,
}: {
  conversationId: string;
  messageSeq: number;
  initial: boolean | null;
}) {
  const [value, setValue] = useState<boolean | null>(initial);
  const [reason, setReason] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function send(helpful: boolean, reasonCode?: string) {
    if (pending) return;
    const previous = value;
    const previousReason = reason;
    setValue(helpful);
    setReason(reasonCode ?? null);
    setFailed(null);
    startTransition(async () => {
      try {
        const { status } = await submitExplanationFeedbackAction(
          conversationId,
          messageSeq,
          helpful,
          reasonCode ? { reasons: [reasonCode] } : undefined,
        );
        if (status !== "saved") {
          setValue(previous);
          setReason(previousReason);
          setFailed(
            status === "rate_limited" ? CHAT_COPY.feedbackRateLimited : CHAT_COPY.feedbackFailed,
          );
        }
      } catch {
        setValue(previous);
        setReason(previousReason);
        setFailed(CHAT_COPY.feedbackFailed);
      }
    });
  }

  return (
    <fieldset className={styles.feedback}>
      <legend className={styles.srOnly}>{CHAT_COPY.explainFeedbackQuestion}</legend>
      <p className={styles.feedbackQuestion} aria-hidden="true">
        {CHAT_COPY.explainFeedbackQuestion}
      </p>
      <div className={styles.feedbackButtons}>
        <button
          type="button"
          className={styles.thumb}
          aria-pressed={value === true}
          aria-label={CHAT_COPY.explainLike}
          disabled={pending}
          onClick={() => value !== true && send(true)}
        >
          <span aria-hidden="true">👍</span>
        </button>
        <button
          type="button"
          className={styles.thumb}
          aria-pressed={value === false}
          aria-label={CHAT_COPY.explainDislike}
          disabled={pending}
          onClick={() => value !== false && send(false)}
        >
          <span aria-hidden="true">👎</span>
        </button>
      </div>
      {value === false ? (
        <fieldset className={styles.explainReasons}>
          <legend className={styles.srOnly}>{CHAT_COPY.explainReasonLabel}</legend>
          {REASONS.map((item) => (
            <button
              key={item.code}
              type="button"
              className={styles.restoreButton}
              aria-pressed={reason === item.code}
              disabled={pending}
              onClick={() => send(false, item.code)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
      ) : null}
      <p className={styles.feedbackStatus} role="status">
        {failed ?? (value !== null ? CHAT_COPY.feedbackThanks : "")}
      </p>
    </fieldset>
  );
}
