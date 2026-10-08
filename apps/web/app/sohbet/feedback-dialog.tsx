"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { CHAT_COPY } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

export const FEEDBACK_REASON_CODES = [
  "not_found",
  "irrelevant",
  "misunderstood",
  "wrong_info",
  "wrong_price_or_product",
  "slow",
  "other",
] as const;
export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];
export const FEEDBACK_COMMENT_MAX = 500;

/**
 * Olumsuz oy modali (karar 0079). Yerel `<dialog>` + `showModal()`: odak tuzagi ve Esc
 * tarayicidan gelir. Burada hicbir sey kaydedilmez; yalnizca Gonder `onSubmit` cagirir.
 * Hata olursa modal acik kalir, yazilan yorum korunur.
 */
export function FeedbackDialog({
  open,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (details: { reasons: FeedbackReasonCode[]; comment: string }) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const commentId = useId();
  const hintId = useId();
  const [reason, setReason] = useState<FeedbackReasonCode | "">("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // Her acilis temiz baslar: onceki gonderimin neden/yorumu kalmaz.
      setReason("");
      setComment("");
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    onSubmit({ reasons: reason ? [reason] : [], comment });
  }

  return (
    <dialog
      ref={ref}
      className={styles.feedbackDialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Esc: tarayicinin kapatmasini engelle, durumu bilesen yonetsin.
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <form className={styles.feedbackForm} onSubmit={submit}>
        <h2 id={titleId} className={styles.feedbackDialogTitle}>
          {CHAT_COPY.feedbackDialogTitle}
        </h2>
        <label htmlFor={reasonId} className={styles.feedbackLabel}>
          {CHAT_COPY.feedbackReasonLabel}
        </label>
        <select
          id={reasonId}
          className={styles.feedbackField}
          value={reason}
          disabled={pending}
          onChange={(event) => setReason(event.target.value as FeedbackReasonCode | "")}
        >
          <option value="">{CHAT_COPY.feedbackReasonPlaceholder}</option>
          {FEEDBACK_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {CHAT_COPY.feedbackReasons[code]}
            </option>
          ))}
        </select>
        <label htmlFor={commentId} className={styles.feedbackLabel}>
          {CHAT_COPY.feedbackCommentLabel}
        </label>
        <textarea
          id={commentId}
          className={styles.feedbackField}
          rows={4}
          maxLength={FEEDBACK_COMMENT_MAX}
          value={comment}
          disabled={pending}
          placeholder={CHAT_COPY.feedbackCommentPlaceholder}
          aria-describedby={hintId}
          onChange={(event) => setComment(event.target.value)}
        />
        <p id={hintId} className={styles.feedbackHint}>
          {CHAT_COPY.feedbackCommentHint} ({comment.length}/{FEEDBACK_COMMENT_MAX})
        </p>
        {error ? (
          <p role="alert" className={styles.feedbackError}>
            {error}
          </p>
        ) : null}
        <div className={styles.feedbackActions}>
          <button
            type="button"
            className={styles.feedbackSecondary}
            disabled={pending}
            onClick={onCancel}
          >
            {CHAT_COPY.feedbackCancel}
          </button>
          <button type="submit" className={styles.feedbackPrimary} disabled={pending}>
            {pending ? CHAT_COPY.feedbackSubmitting : CHAT_COPY.feedbackSubmit}
          </button>
        </div>
      </form>
    </dialog>
  );
}
