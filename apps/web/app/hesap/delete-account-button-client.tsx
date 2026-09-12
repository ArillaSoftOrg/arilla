"use client";

import { Button } from "@arilla/ui";
import { useState } from "react";
import { deleteAccountAction } from "./actions.ts";

/** docs/pages.md: "Onay adımı vardır ama geri alınamaz olduğu açıkça yazılır." (docs/copy.md `legal.delete_warning`) */
export function DeleteAccountButtonClient() {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (!confirming) {
    return (
      <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
        Hesabı sil
      </Button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <p style={{ margin: 0, color: "var(--alert)" }}>Bu işlem geri alınamaz.</p>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            await deleteAccountAction();
          }}
        >
          Evet, hesabımı sil
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Vazgeç
        </Button>
      </div>
    </div>
  );
}
