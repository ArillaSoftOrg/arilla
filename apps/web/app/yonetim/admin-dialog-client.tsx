"use client";

import { Button } from "@arilla/ui";
import { type ReactNode, useId, useRef } from "react";
import styles from "./admin.module.css";

/**
 * Yönetim diyaloğu (docs/decisions/0083): yerel modal `<dialog>`. Odak tuzağı,
 * Esc ile kapanma ve kapanınca odağın açan düğmeye dönmesi tarayıcıdan gelir.
 * Örtüye tıklama bilerek kapatmaz (yanlışlıkla iptal olmasın). İçerik
 * `close` fonksiyonunu alır; eylem düğmeleri `DialogActions` içinde durur.
 */
export function AdminDialog({
  triggerLabel,
  triggerVariant = "secondary",
  triggerDisabled = false,
  title,
  description,
  children,
}: {
  triggerLabel: string;
  triggerVariant?: "primary" | "secondary" | "accent" | "ghost";
  triggerDisabled?: boolean;
  title: string;
  description?: string;
  children: (close: () => void) => ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = () => dialogRef.current?.close();

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        disabled={triggerDisabled}
        aria-haspopup="dialog"
        onClick={() => dialogRef.current?.showModal()}
      >
        {triggerLabel}
      </Button>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className={styles.dialogBody}>
          <h2 id={titleId} className={styles.sectionTitle}>
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className={styles.muted}>
              {description}
            </p>
          ) : null}
          {children(close)}
        </div>
      </dialog>
    </>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.dialogActions}>{children}</div>;
}
