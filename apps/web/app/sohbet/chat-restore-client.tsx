"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { restoreSearchAction } from "./actions.ts";
import { CHAT_COPY } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

function noteFor(status: string): string | null {
  switch (status) {
    case "restored":
    case "already_current":
      return null;
    case "busy":
      return CHAT_COPY.restoreBusy;
    case "rate_limited":
      return CHAT_COPY.restoreRateLimited;
    case "conversation_full":
      return CHAT_COPY.restoreFull;
    default:
      return CHAT_COPY.restoreFailed;
  }
}

/**
 * "Bu aramaya dön" (karar 0199). İnce istemci: niyet sunucuda saklı mesajdan okunur; burada
 * yalnızca mesaj sırası ve tekilleştirme anahtarı gider. Anahtar bileşen ömrünce sabittir, bu yüzden
 * çift tıklama aynı isteği tekrarlar (sunucu `duplicate` döner, ikinci tur açılmaz).
 */
export function RestoreSearchButton({
  conversationId,
  messageSeq,
  query,
}: {
  conversationId: string;
  messageSeq: number;
  query: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);

  function restore() {
    if (pending) return;
    keyRef.current ??= crypto.randomUUID();
    const requestKey = keyRef.current;
    setNote(null);
    startTransition(async () => {
      try {
        const { status } = await restoreSearchAction(conversationId, messageSeq, requestKey);
        const message = noteFor(status);
        if (message) {
          setNote(message);
          // Yeni deneme yeni anahtar: hata sonrasi tiklama tekrar yazabilsin.
          keyRef.current = null;
          return;
        }
        // Yeni tur yazıldı (ya da zaten güncel): sunucu bileşenleri yeniden çizilsin.
        keyRef.current = null;
        router.refresh();
      } catch {
        keyRef.current = null;
        setNote(CHAT_COPY.restoreFailed);
      }
    });
  }

  return (
    <div className={styles.restore}>
      <button
        type="button"
        className={styles.restoreButton}
        onClick={restore}
        disabled={pending}
        aria-label={CHAT_COPY.restoreSearchLabel(query)}
      >
        {CHAT_COPY.restoreSearch}
      </button>
      {note ? (
        <span className={styles.restoreNote} role="status">
          {note}
        </span>
      ) : null}
    </div>
  );
}
