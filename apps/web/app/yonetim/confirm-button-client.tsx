"use client";

import { Button } from "@arilla/ui";
import { useId, useRef } from "react";
import styles from "./admin.module.css";

/**
 * Yıkıcı işlem onayı: yerel `<dialog>` (odak tuzağı ve Esc tarayıcıdan).
 * Varsayılan odak "Vazgeç"tedir; Enter yanlışlıkla silmez.
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => dialogRef.current?.showModal()}
      >
        {label}
      </Button>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <h2 id={titleId} className={styles.sectionTitle}>
            {title}
          </h2>
          <p id={descriptionId} className={styles.muted}>
            {description}
          </p>
          <div className={styles.row}>
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => dialogRef.current?.close()}
            >
              Vazgeç
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                dialogRef.current?.close();
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
