"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import styles from "../../admin.module.css";
import { startSendAction } from "../actions.ts";

/**
 * Gerçek gönderim onayı. Pencere konu, o anki uygun alıcı sayısı ve iznin
 * gönderim anında yeniden denetleneceğini söyler; kutu işaretlenmeden düğme
 * açılmaz. Asıl korumalar sunucuda: taze giriş, test edilmiş içerik sürümü,
 * kampanya durumu (`draft` → `sending` tek işlemde), alıcı başına tekil satır.
 * Düğmeyi kilitlemek yalnızca kolaylıktır.
 */
export function SendCampaignClient({
  publicId,
  contentVersion,
  subject,
  eligibleCount,
  disabledReason,
}: {
  publicId: string;
  contentVersion: number;
  subject: string;
  eligibleCount: number;
  /** Gönderim açılmıyorsa nedeni (test yok, ortam kapalı ...). */
  disabledReason: string | null;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
    reauthHref?: string;
  } | null>(null);

  async function submit() {
    setPending(true);
    setMessage(null);
    try {
      const result = await startSendAction({
        publicId,
        expectedContentVersion: contentVersion,
        confirmed,
      });
      if (!result.ok) {
        setMessage({ text: result.message, error: true, reauthHref: result.reauthHref });
        return;
      }
      dialogRef.current?.close();
      setMessage({
        text: result.alreadyStarted
          ? "Bu kampanyanın gönderimi zaten başlamıştı; yeni gönderim yapılmadı."
          : "Gönderim başladı.",
        error: false,
      });
      router.refresh();
    } catch {
      setMessage({ text: "Başlatılamadı. Sayfayı yenileyip durumu kontrol et.", error: true });
    } finally {
      setPending(false);
    }
  }

  const feedback = message ? (
    <p
      role={message.error ? "alert" : "status"}
      className={message.error ? styles.statusBad : styles.muted}
    >
      {message.text}
      {message.reauthHref ? (
        <>
          {" "}
          <a href={message.reauthHref}>Yeniden giriş yap</a>
        </>
      ) : null}
    </p>
  ) : null;

  return (
    <div className={styles.pageHeader}>
      {disabledReason ? <p className={styles.muted}>{disabledReason}</p> : null}
      <div className={styles.row}>
        <Button
          type="button"
          variant="primary"
          disabled={disabledReason !== null}
          onClick={() => {
            setMessage(null);
            setConfirmed(false);
            dialogRef.current?.showModal();
          }}
        >
          Gerçek gönderimi başlat
        </Button>
      </div>
      {feedback}
      <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId}>
        <form
          style={{ display: "grid", gap: "var(--space-3)" }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 id={titleId} className={styles.sectionTitle}>
            Gerçek gönderimi başlat
          </h2>
          <p>
            <strong>Konu:</strong> {subject}
          </p>
          <p>
            Şu anda <strong>{eligibleCount.toLocaleString("tr-TR")}</strong> hesap uygun. Bu işlem
            gerçek kullanıcılara e-posta gönderir ve geri alınamaz.
          </p>
          <p className={styles.muted}>
            Her alıcının izni ve adresi ileti gönderilmeden hemen önce yeniden denetlenir; bu arada
            iznini geri alan kişiye gönderilmez. Gönderim arka planda partiler hâlinde sürer.
          </p>
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>Bu kampanyanın gerçek alıcılara gönderileceğini anlıyorum.</span>
          </label>
          {message?.error ? feedback : null}
          <div className={styles.row}>
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => dialogRef.current?.close()}
            >
              Vazgeç
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !confirmed}>
              Gönder
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
