"use client";

import { Button } from "@arilla/ui";
import { useState } from "react";
import { deleteAccountAction } from "./actions.ts";
import styles from "./page.module.css";

/** docs/pages.md: "Onay adımı vardır ama geri alınamaz olduğu açıkça yazılır." (docs/copy.md `legal.delete_warning`) */
export function DeleteAccountButtonClient() {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!confirming) {
    return (
      <Button type="button" variant="secondary" shape="pill" onClick={() => setConfirming(true)}>
        Hesabı sil
      </Button>
    );
  }

  return (
    <div className={styles.dangerActions}>
      <p className={styles.warningText}>Bu işlem geri alınamaz.</p>
      {message ? (
        <p className={styles.warningText} role="alert">
          {message}
        </p>
      ) : null}
      <div className={styles.inlineButtonRow}>
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
          onClick={() => setConfirming(false)}
        >
          Vazgeç
        </Button>
      </div>
    </div>
  );
}
