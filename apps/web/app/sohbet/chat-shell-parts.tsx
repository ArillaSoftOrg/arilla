import { ArrowRightIcon, Button, VisuallyHidden } from "@arilla/ui";
import type { FormEvent, KeyboardEvent } from "react";
import { CHAT_COPY } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

/**
 * Sohbet kabugunun ortak parcalari: `/sohbet/yeni` (onyukleme) ve
 * `/sohbet/[id]` (`ChatInteractive`, `ChatThread`) AYNI isaretlemeyi kullanir;
 * gecis sirasinda yerlesim kaymasi olmaz. Is mantigi yok.
 */

export function ChatUserRow({ text }: { text: string }) {
  return (
    <li className={`${styles.row} ${styles.rowUser}`}>
      <VisuallyHidden as="span">{CHAT_COPY.userLabel}: </VisuallyHidden>
      <p className={`${styles.bubble} ${styles.bubbleUser}`}>{text}</p>
    </li>
  );
}

/** Sakin bekleme gostergesi: yalnizca noktalar; metin yalnizca ekran okuyucuya. */
export function ChatPendingRow() {
  return (
    <div className={`${styles.row} ${styles.rowAssistant}`}>
      <p className={`${styles.bubble} ${styles.bubbleAssistant} ${styles.thinking}`} role="status">
        <span className={styles.dots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <VisuallyHidden as="span">{CHAT_COPY.thinking}</VisuallyHidden>
      </p>
    </div>
  );
}

export const CHAT_MESSAGE_MAX = 500;

export function ChatComposer({
  draft,
  onDraftChange,
  onSubmit,
  onKeyDown,
  locked,
  busy = false,
}: {
  draft: string;
  onDraftChange?: (value: string) => void;
  onSubmit?: (event: FormEvent) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Girdi ve gonder dugmesi kapali (cevap bekleniyor / sohbet hazir degil). */
  locked: boolean;
  busy?: boolean;
}) {
  return (
    <form className={styles.composer} onSubmit={onSubmit}>
      <label className={styles.composerLabel}>
        <VisuallyHidden as="span">{CHAT_COPY.composerLabel}</VisuallyHidden>
        <textarea
          className={styles.composerInput}
          rows={1}
          value={draft}
          maxLength={CHAT_MESSAGE_MAX}
          placeholder={CHAT_COPY.composerPlaceholder}
          disabled={locked}
          enterKeyHint="send"
          onChange={(event) => onDraftChange?.(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <Button
        type="submit"
        variant="accent"
        className={styles.send}
        aria-label={busy ? CHAT_COPY.sending : CHAT_COPY.sendLabel}
        disabled={locked || draft.trim() === ""}
      >
        <ArrowRightIcon />
      </Button>
    </form>
  );
}
