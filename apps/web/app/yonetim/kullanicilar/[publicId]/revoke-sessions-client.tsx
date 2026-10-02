"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import styles from "../../admin.module.css";
import { revokeUserSessionsAction } from "../actions.ts";

/**
 * Hesabın bütün oturumlarını kapat (karar 0050). Gerekçe zorunlu; asıl
 * denetim sunucudadır (yetki, taze giriş, denetim kaydı). Bu bileşen
 * yalnızca yetkili yöneticiye render edilir ama gizlemek yetki değildir.
 */
export function RevokeSessionsClient({
  publicId,
  activeSessions,
}: {
  publicId: string;
  activeSessions: number;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState("");
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
      const result = await revokeUserSessionsAction({ publicId, reason });
      if (!result.ok) {
        setMessage({ text: result.message, error: true, reauthHref: result.reauthHref });
        return;
      }
      dialogRef.current?.close();
      setReason("");
      setMessage({ text: `${result.count} oturum kapatıldı.`, error: false });
      router.refresh();
    } catch {
      setMessage({ text: "Kapatılamadı. Tekrar dene.", error: true });
    } finally {
      setPending(false);
    }
  }

  const notice = message ? (
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
      <div className={styles.row}>
        <Button
          type="button"
          variant="secondary"
          disabled={activeSessions === 0}
          onClick={() => {
            setMessage(null);
            dialogRef.current?.showModal();
          }}
        >
          Tüm oturumları kapat
        </Button>
      </div>
      {notice}
      <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId}>
        <form
          style={{ display: "grid", gap: "var(--space-3)" }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 id={titleId} className={styles.sectionTitle}>
            Tüm oturumları kapat
          </h2>
          <p className={styles.muted}>
            Hesap bütün cihazlarda çıkış yapar ve yeniden giriş yapması gerekir. Rol değişmez.
          </p>
          <label className={styles.pageHeader}>
            <span className={styles.meta}>Gerekçe (denetim kaydına yazılır)</span>
            <textarea
              required
              minLength={5}
              maxLength={300}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {message?.error ? notice : null}
          <div className={styles.row}>
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => dialogRef.current?.close()}
            >
              Vazgeç
            </Button>
            <Button type="submit" variant="primary" disabled={pending || reason.trim().length < 5}>
              Kapat
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
