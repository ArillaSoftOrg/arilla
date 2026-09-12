"use client";

import { type ReactNode, useEffect } from "react";
import styles from "./LoginModal.module.css";

export interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  closeLabel: string;
  children: ReactNode;
}

/**
 * docs/design.md "Giriş modali": sonuçların üstünde, sonuçlar arkada okunur
 * halde kalır - bu bileşen içeriği kaldırmaz, yalnızca üstüne biner.
 * `open=false` iken hiçbir şey render etmez (SEO rotalarında hiç
 * kullanılmaz, `/ara` dışında çağrılmamalı).
 *
 * Kapatma yalnızca klavye erişilebilir yollarla: görünür × düğmesi ve Esc.
 * Overlay'e tıklama kasıtlı olarak yok - a11y açısından belirsiz bir
 * etkileşim ekler, × ve Esc yeterli.
 */
export function LoginModal({
  open,
  onClose,
  title,
  description,
  closeLabel,
  children,
}: LoginModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={styles.overlay}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className={styles.close} onClick={onClose} aria-label={closeLabel}>
          ×
        </button>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.description}>{description}</p>
        {children}
      </div>
    </div>
  );
}
