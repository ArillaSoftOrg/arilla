"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { submitResultFeedbackAction } from "./actions.ts";
import { CHAT_COPY } from "./chat-copy.ts";
import { chatMark } from "./chat-metrics.ts";
import { FeedbackDialog, type FeedbackReasonCode } from "./feedback-dialog.tsx";
import styles from "./sohbet.module.css";

function failureText(status: string): string {
  return status === "rate_limited" ? CHAT_COPY.feedbackRateLimited : CHAT_COPY.feedbackFailed;
}

/**
 * "Bu yardımcı oldu mu?" (karar 0075, 0079). İnce istemci: oy sunucuda saklanır.
 * Olumlu oy tek tıkla kaydedilir. Olumsuz oy modal açar; yalnızca Gönder kaydeder,
 * İptal hiçbir şey yazmaz. Seçili durum yalnızca renkle değil `aria-pressed` ve kalın
 * çerçeveyle verilir.
 */
export function ResultFeedback({
  conversationId,
  messageSeq,
  initial,
}: {
  conversationId: string;
  messageSeq: number;
  initial: boolean | null;
}) {
  const [value, setValue] = useState<boolean | null>(initial);
  const [failed, setFailed] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const downRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  // Bu blok yalnizca sonuclar cizilince baglanir: urunler gorunur.
  useEffect(() => {
    chatMark("chat:products_visible");
  }, []);

  // Olumlu: tek tik, hemen kaydedilir. Hata olursa onceki degere doner.
  function voteUp() {
    if (pending || value === true) return;
    const previous = value;
    setValue(true);
    setFailed(null);
    startTransition(async () => {
      try {
        const { status } = await submitResultFeedbackAction(conversationId, messageSeq, true);
        if (status !== "saved") {
          setValue(previous);
          setFailed(failureText(status));
        }
      } catch {
        setValue(previous);
        setFailed(CHAT_COPY.feedbackFailed);
      }
    });
  }

  // Odak 👎 dugmesine doner (iptal ve basarida). Basarida dugme hala `disabled` (gecis
  // bitmedi) oldugundan odak yalnizca `pending` bitince verilir; aksi halde <body>'ye duser.
  useEffect(() => {
    if (!pending && !dialogOpen && refocus.current) {
      refocus.current = false;
      downRef.current?.focus();
    }
  });

  function closeDialog() {
    refocus.current = true;
    setDialogOpen(false);
    setFailed(null);
  }

  function sendNegative(details: { reasons: FeedbackReasonCode[]; comment: string }) {
    setFailed(null);
    startTransition(async () => {
      try {
        const { status } = await submitResultFeedbackAction(
          conversationId,
          messageSeq,
          false,
          details,
        );
        if (status === "saved") {
          setValue(false);
          closeDialog();
        } else {
          setFailed(failureText(status));
        }
      } catch {
        setFailed(CHAT_COPY.feedbackFailed);
      }
    });
  }

  return (
    <fieldset className={styles.feedback}>
      <legend className={styles.srOnly}>{CHAT_COPY.feedbackQuestion}</legend>
      <p className={styles.feedbackQuestion} aria-hidden="true">
        {CHAT_COPY.feedbackQuestion}
      </p>
      <div className={styles.feedbackButtons}>
        <button
          type="button"
          className={styles.thumb}
          aria-pressed={value === true}
          aria-label={CHAT_COPY.feedbackYes}
          disabled={pending}
          onClick={voteUp}
        >
          <span aria-hidden="true">👍</span>
        </button>
        <button
          type="button"
          ref={downRef}
          className={styles.thumb}
          aria-pressed={value === false}
          aria-haspopup="dialog"
          aria-label={CHAT_COPY.feedbackNo}
          disabled={pending}
          onClick={() => {
            setFailed(null);
            setDialogOpen(true);
          }}
        >
          <span aria-hidden="true">👎</span>
        </button>
      </div>
      <p className={styles.feedbackStatus} role="status">
        {dialogOpen ? "" : (failed ?? (value !== null ? CHAT_COPY.feedbackThanks : ""))}
      </p>
      <FeedbackDialog
        open={dialogOpen}
        pending={pending}
        error={dialogOpen ? failed : null}
        onCancel={closeDialog}
        onSubmit={sendNegative}
      />
    </fieldset>
  );
}
