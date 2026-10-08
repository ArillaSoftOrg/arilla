import {
  ArrowRightIcon,
  Button,
  CloseIcon,
  PhotoUploadButton,
  PlusIcon,
  VisuallyHidden,
} from "@arilla/ui";
import type { FormEvent, KeyboardEvent } from "react";
import { CHAT_COPY } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

/**
 * Sohbet kabugunun ortak parcalari: `/sohbet/yeni` (onyukleme) ve
 * `/sohbet/[id]` (`ChatInteractive`, `ChatThread`) AYNI isaretlemeyi kullanir;
 * gecis sirasinda yerlesim kaymasi olmaz. Is mantigi yok.
 */

export function ChatUserRow({ text, imageSrc }: { text: string; imageSrc?: string | null }) {
  return (
    <li className={`${styles.row} ${styles.rowUser}`}>
      <VisuallyHidden as="span">{CHAT_COPY.userLabel}: </VisuallyHidden>
      {imageSrc ? (
        // Karar 0078: fotograf ve metin TEK mesajdir; ayni balonun icinde.
        <div className={`${styles.bubble} ${styles.bubbleUser} ${styles.bubbleWithImage}`}>
          {/* biome-ignore lint/performance/noImgElement: kimlikli, onbelleksiz ozel rota; next/image optimizasyonu yok. */}
          <img
            className={styles.bubbleImage}
            src={imageSrc}
            alt={CHAT_COPY.attachedPhotoAlt}
            width={512}
            height={512}
            decoding="async"
          />
          {text ? <p className={styles.bubbleText}>{text}</p> : null}
        </div>
      ) : (
        <p className={`${styles.bubble} ${styles.bubbleUser}`}>{text}</p>
      )}
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

/**
 * Karar 0079: mesaja eklenecek (henuz gonderilmemis) fotograf. Secmek gondermez; onizleme olur.
 * Ana sayfa kutusuyla ayni anlam: metin bos olabilir, Enter ve Gonder ayni eylemi calistirir.
 */
export interface ChatComposerAttachment {
  /** Onizleme blob adresi; secili fotograf yoksa `null`. */
  previewUrl: string | null;
  onFileSelected: (file: File) => void;
  onRemove: () => void;
}

export function ChatComposer({
  draft,
  onDraftChange,
  onSubmit,
  onKeyDown,
  locked,
  busy = false,
  attachment,
}: {
  draft: string;
  onDraftChange?: (value: string) => void;
  onSubmit?: (event: FormEvent) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Girdi ve gonder dugmesi kapali (cevap bekleniyor / sohbet hazir degil). */
  locked: boolean;
  busy?: boolean;
  /** Verilmezse (bayrak kapali, `/sohbet/yeni` kabugu) "+" hic gorunmez. */
  attachment?: ChatComposerAttachment;
}) {
  const hasImage = Boolean(attachment?.previewUrl);
  return (
    <form className={styles.composer} onSubmit={onSubmit}>
      {attachment ? (
        <PhotoUploadButton
          iconOnly
          icon={<PlusIcon />}
          label={hasImage ? CHAT_COPY.attachReplaceLabel : CHAT_COPY.attachLabel}
          onFileSelected={attachment.onFileSelected}
          disabled={locked}
          variant="ghost"
          className={styles.attach}
        />
      ) : null}
      {attachment?.previewUrl ? (
        <div className={styles.attachmentPreview}>
          {/* biome-ignore lint/performance/noImgElement: yerel blob onizlemesi; next/image uygun degil. */}
          <img
            className={styles.attachmentPreviewImage}
            src={attachment.previewUrl}
            alt={CHAT_COPY.attachPreviewAlt}
          />
          <button
            type="button"
            className={styles.attachmentPreviewRemove}
            aria-label={CHAT_COPY.attachRemoveLabel}
            disabled={locked}
            onClick={attachment.onRemove}
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}
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
        disabled={locked || (draft.trim() === "" && !hasImage)}
      >
        <ArrowRightIcon />
      </Button>
    </form>
  );
}
