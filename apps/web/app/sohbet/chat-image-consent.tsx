"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { setChatImageConsentAction } from "./actions.ts";
import styles from "./chat-image-consent.module.css";
import { CHAT_IMAGE_CONSENT_COPY as COPY } from "./chat-image-consent-copy.ts";

/**
 * Fotograf eklemeden once bilgilendirme + ACIK riza (karar 0101). Yerel `<dialog>`.
 * Kabul ve ret esit agirlikli iki ayri dugmedir; hicbiri onceden secili degildir,
 * Esc ya da dis tiklama KABUL SAYILMAZ (ret gibi kapanir, kayit yazilmaz).
 */
export function ChatImageConsentDialog({
  open,
  pending,
  error,
  onAccept,
  onDecline,
}: {
  open: boolean;
  pending: boolean;
  error: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onDecline();
      }}
    >
      {open ? (
        <div className={styles.body}>
          <h2 id={titleId} className={styles.title}>
            {COPY.title}
          </h2>
          <p className={styles.text}>{COPY.intro}</p>
          <ul className={styles.list}>
            {COPY.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p className={styles.text}>{COPY.withdraw}</p>
          <p className={styles.text}>
            <Link className={styles.link} href={COPY.detailsHref} target="_blank">
              {COPY.detailsLabel}
            </Link>
          </p>
          {error ? (
            <p role="alert" className={styles.error}>
              {COPY.saveError}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={styles.choice} disabled={pending} onClick={onDecline}>
              {COPY.decline}
            </button>
            <button type="button" className={styles.choice} disabled={pending} onClick={onAccept}>
              {COPY.accept}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * Secilen dosyayi rizaya kadar BEKLETIR (yalniz bellekte; sunucuya hicbir sey gitmez).
 * Riza varsa dosya dogrudan gecer. Kabul -> kayit -> dosya gecer; ret/Esc -> dosya atilir.
 * Sunucu eylemleri rizayi ayrica denetler; burasi yalnizca bilgilendirme ve karar anidir.
 */
export function useChatImageConsentGate(initiallyGranted: boolean) {
  const [granted, setGranted] = useState(initiallyGranted);
  const [waiting, setWaiting] = useState<{ file: File; proceed: (file: File) => void } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [declined, setDeclined] = useState(false);

  function gate(file: File, proceed: (file: File) => void): void {
    setDeclined(false);
    if (granted) {
      proceed(file);
      return;
    }
    setError(false);
    setWaiting({ file, proceed });
  }

  async function accept(): Promise<void> {
    if (!waiting || pending) return;
    setPending(true);
    setError(false);
    try {
      const { status } = await setChatImageConsentAction(true);
      if (status !== "saved") {
        setError(true);
        return;
      }
      setGranted(true);
      const { file, proceed } = waiting;
      setWaiting(null);
      proceed(file);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  function decline(): void {
    if (pending) return;
    setWaiting(null);
    setDeclined(true);
  }

  return {
    gate,
    /** Ret sonrasi kullaniciya gosterilecek kisa bilgi; yeni secimde silinir. */
    declinedNotice: declined ? COPY.declined : null,
    dialog: (
      <ChatImageConsentDialog
        open={waiting !== null}
        pending={pending}
        error={error}
        onAccept={() => void accept()}
        onDecline={decline}
      />
    ),
  };
}
