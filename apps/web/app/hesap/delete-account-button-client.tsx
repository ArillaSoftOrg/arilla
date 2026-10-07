"use client";

import { Button } from "@arilla/ui";
import { useEffect, useRef, useState } from "react";
import { deleteAccountAction } from "./actions.ts";
import styles from "./page.module.css";

/**
 * docs/pages.md: "Onay adımı vardır ama geri alınamaz olduğu açıkça yazılır."
 * (docs/copy.md `legal.delete_warning`). "Yönet" menüsünden açılır; asıl
 * silme `deleteAccountAction` (karar 0050) - bu bileşen yalnızca onay adımı.
 */
export function DeleteAccountConfirmClient({ onCancel }: { onCancel: () => void }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      className={styles.confirmPanel}
      role="alertdialog"
      aria-labelledby="hesap-sil-baslik"
      aria-describedby="hesap-sil-aciklama"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onCancel();
      }}
    >
      <h2 id="hesap-sil-baslik" className={styles.confirmTitle}>
        Hesabını silmek istiyor musun?
      </h2>
      <p id="hesap-sil-aciklama" className={styles.cardText}>
        Bu işlem geri alınamaz.
      </p>
      {message ? (
        <p className={styles.cardText} role="alert">
          {message}
        </p>
      ) : null}
      <div className={styles.confirmActions}>
        <Button
          type="button"
          variant="secondary"
          shape="pill"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            // Başarıda yönlendirme olur; dönen değer yalnızca reddedilen durum.
            const result = await deleteAccountAction();
            setMessage(result.message);
            setPending(false);
          }}
        >
          Evet, hesabımı sil
        </Button>
        <Button
          type="button"
          variant="secondary"
          shape="pill"
          disabled={pending}
          onClick={onCancel}
        >
          Vazgeç
        </Button>
      </div>
    </div>
  );
}
