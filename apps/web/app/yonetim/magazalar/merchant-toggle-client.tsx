"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import styles from "../admin.module.css";
import { setMerchantActiveAction } from "./actions.ts";

/**
 * Mağazayı aç/kapat. Onay penceresi gerekçe ve mağaza kısa adının aynen
 * yazılmasını ister; asıl denetim sunucudadır (yetki, taze oturum, onay adı).
 * Bu bileşen yalnızca yöneticiye render edilir ama gizlemek yetki değildir.
 */
export function MerchantToggleClient({
  merchantId,
  slug,
  isActive,
}: {
  merchantId: number;
  slug: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [confirmSlug, setConfirmSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const next = !isActive;

  async function submit() {
    setPending(true);
    setMessage(null);
    try {
      const result = await setMerchantActiveAction({
        merchantId,
        active: next,
        reason,
        confirmSlug,
      });
      if (!result.ok) {
        setMessage({ text: result.message, error: true });
        return;
      }
      dialogRef.current?.close();
      setReason("");
      setConfirmSlug("");
      setMessage({
        text: result.changed ? "Kaydedildi." : "Mağaza zaten bu durumdaydı.",
        error: false,
      });
      router.refresh();
    } catch {
      setMessage({ text: "Kaydedilemedi. Tekrar dene.", error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.pageHeader}>
      <div className={styles.row}>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setMessage(null);
            dialogRef.current?.showModal();
          }}
        >
          {isActive ? "Veri toplamayı kapat" : "Veri toplamayı aç"}
        </Button>
      </div>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? styles.statusBad : styles.muted}
        >
          {message.text}
        </p>
      ) : null}
      <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId}>
        <form
          style={{ display: "grid", gap: "var(--space-3)" }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 id={titleId} className={styles.sectionTitle}>
            {isActive ? "Veri toplamayı kapat" : "Veri toplamayı aç"}
          </h2>
          <p className={styles.muted}>
            {isActive
              ? "Kapalı mağaza için sonraki toplama koşusu çalışmadan durur. Mevcut teklifler silinmez."
              : "Açmak Shopify para birimi kapısını atlamaz; doğrulanmamış mağaza yine toplanmaz."}
          </p>
          <label className={styles.pageHeader}>
            <span className={styles.meta}>Gerekçe (denetim kaydına yazılır)</span>
            <textarea
              required
              minLength={5}
              maxLength={500}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label className={styles.pageHeader}>
            <span
              className={styles.meta}
            >{`Onaylamak için mağazanın kısa adını yaz: ${slug}`}</span>
            <input
              required
              autoComplete="off"
              value={confirmSlug}
              onChange={(event) => setConfirmSlug(event.target.value)}
            />
          </label>
          {message?.error ? (
            <p role="alert" className={styles.statusBad}>
              {message.text}
            </p>
          ) : null}
          <div className={styles.row}>
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => dialogRef.current?.close()}
            >
              Vazgeç
            </Button>
            <Button type="submit" variant="primary" disabled={pending || confirmSlug !== slug}>
              {isActive ? "Kapat" : "Aç"}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
