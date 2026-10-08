"use client";

import { Button } from "@arilla/ui";
import { AdminDialog, DialogActions } from "./admin-dialog-client.tsx";

/**
 * Yıkıcı işlem onayı (`AdminDialog` üzerinde). Varsayılan odak "Vazgeç"tedir;
 * Enter yanlışlıkla silmez.
 */
export function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  disabled = false,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AdminDialog
      triggerLabel={label}
      triggerDisabled={disabled}
      title={title}
      description={description}
    >
      {(close) => (
        <DialogActions>
          <Button type="button" variant="secondary" autoFocus onClick={close}>
            Vazgeç
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              close();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      )}
    </AdminDialog>
  );
}
