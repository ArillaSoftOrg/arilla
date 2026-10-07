"use client";

import { useState, useTransition } from "react";
import { submitResultFeedbackAction } from "./actions.ts";
import { CHAT_COPY } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

/**
 * "Bu yardımcı oldu mu?" (karar 0075). İnce istemci: oy sunucuda saklanır, metin
 * taşımaz. Seçili durum yalnızca renkle değil `aria-pressed` ve kalın çerçeveyle verilir.
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
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function vote(helpful: boolean) {
    if (pending || value === helpful) return;
    const previous = value;
    setValue(helpful);
    setFailed(false);
    startTransition(async () => {
      try {
        const { status } = await submitResultFeedbackAction(conversationId, messageSeq, helpful);
        if (status !== "saved") throw new Error("not saved");
      } catch {
        setValue(previous);
        setFailed(true);
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
          onClick={() => vote(true)}
        >
          <span aria-hidden="true">👍</span>
        </button>
        <button
          type="button"
          className={styles.thumb}
          aria-pressed={value === false}
          aria-label={CHAT_COPY.feedbackNo}
          disabled={pending}
          onClick={() => vote(false)}
        >
          <span aria-hidden="true">👎</span>
        </button>
      </div>
      <p className={styles.feedbackStatus} role="status">
        {failed ? CHAT_COPY.feedbackFailed : value !== null ? CHAT_COPY.feedbackThanks : ""}
      </p>
    </fieldset>
  );
}
