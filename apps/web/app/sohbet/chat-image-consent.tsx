"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { setChatImageConsentAction } from "./actions.ts";
import styles from "./chat-image-consent.module.css";
import { CHAT_IMAGE_CONSENT_COPY as COPY } from "./chat-image-consent-copy.ts";

/**
 * Fotograf eklerken kisa bilgilendirme + ACIK riza (karar 0101, 0105). Modal degil,
 * kompozerin ustunde satir ici seritir; secilen fotografin onizlemesi yaninda gorunur.
 * Kabul ve ret esit agirlikli iki ayri dugmedir; hicbiri onceden secili degildir,
 * onay kutusu yoktur. Esc ya da yok sayma KABUL SAYILMAZ (ret gibi kapanir, kayit yazilmaz).
 */
export function ChatImageConsentPrompt({
  open,
  previewUrl,
  pending,
  error,
  onAccept,
  onDecline,
}: {
  open: boolean;
  previewUrl?: string | null;
  pending: boolean;
  error: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const titleId = useId();
  if (!open) return null;
  return (
    <section
      className={styles.panel}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onDecline();
      }}
    >
      {previewUrl ? (
        // biome-ignore lint/performance/noImgElement: yerel blob onizlemesi, optimize edilecek bir kaynak degil.
        <img className={styles.thumb} src={previewUrl} alt={COPY.previewAlt} />
      ) : null}
      <div className={styles.content}>
        <h2 id={titleId} className={styles.title}>
          {COPY.title}
        </h2>
        <p className={styles.text}>{COPY.summary}</p>
        <p className={styles.text}>
          {COPY.withdraw}{" "}
          <Link className={styles.link} href={COPY.privacyHref} target="_blank">
            {COPY.privacyLabel}
          </Link>
          {" · "}
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
    </section>
  );
}

/**
 * Secilen dosyayi rizaya kadar BEKLETIR (yalniz bellekte; sunucuya hicbir sey gitmez).
 * Riza varsa dosya dogrudan gecer (onizleme / gonder). Kabul -> kayit -> dosya gecer;
 * ret/Esc -> dosya atilir. Sunucu eylemleri rizayi ayrica denetler; burasi yalnizca
 * bilgilendirme ve karar anidir.
 */
export function useChatImageConsentGate(initiallyGranted: boolean) {
  const [granted, setGranted] = useState(initiallyGranted);
  const [waiting, setWaiting] = useState<{ file: File; proceed: (file: File) => void } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [declined, setDeclined] = useState(false);
  // Onizleme yalniz bellekteki dosyadan uretilir (sunucuya/depoya yazilmaz); kapaninca serbest birakilir.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const waitingFile = waiting?.file ?? null;

  useEffect(() => {
    if (!waitingFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(waitingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [waitingFile]);

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
    prompt: (
      <ChatImageConsentPrompt
        open={waiting !== null}
        previewUrl={previewUrl}
        pending={pending}
        error={error}
        onAccept={() => void accept()}
        onDecline={decline}
      />
    ),
  };
}
