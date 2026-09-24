"use client";

import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { CloseIcon } from "./icons.tsx";
import styles from "./LoginModal.module.css";

export interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  closeLabel: string;
  /**
   * Kapaninca odagin donecegi oge. Verilmezse acilis anindaki
   * `document.activeElement`. Acan dugme istek sirasinda `disabled` olursa
   * tarayici odagi `<body>`'ye tasir - o durumda cagiran taraf dugmeyi verir.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden") && el.getClientRects().length > 0,
  );
}

/**
 * docs/design.md "Giriş modali": sonuçların üstünde, sonuçlar arkada okunur
 * halde kalır - bu bileşen içeriği kaldırmaz, yalnızca üstüne biner (karar
 * 0002). `open=false` iken hiçbir şey render etmez (SEO rotalarında hiç
 * kullanılmaz).
 *
 * Odak yönetimi: açılınca odak diyaloğun ilk içerik alanına (yoksa ×
 * düğmesine, o da yoksa diyaloğun kendisine) taşınır, Tab/Shift+Tab diyalog
 * içinde döner, kapanınca odak açan öğeye geri verilir. Açıkken sayfa
 * kaydırması kilitlenir.
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
  returnFocusRef,
  children,
}: LoginModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRefRef = useRef(returnFocusRef);
  returnFocusRefRef.current = returnFocusRef;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const active = document.activeElement;
    const opener =
      returnFocusRefRef.current?.current ??
      (active instanceof HTMLElement && active !== document.body ? active : null);

    // Ilk odak: x dugmesi yerine icerikteki ilk alan (orn. e-posta girdisi).
    const candidates = focusableIn(dialog);
    const initial =
      candidates.find((el) => el.dataset.modalClose === undefined) ?? candidates[0] ?? dialog;
    initial.focus();

    // Kaydirma kilidi; kaydirma cubugu kaybolunca icerik yana kaymasin.
    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

    function onKeyDown(event: KeyboardEvent) {
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableIn(dialog);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (event.shiftKey && (active === first || active === dialog || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    }

    // Odak baska bir yolla diyalog disina cikarsa geri al.
    function onFocusIn(event: FocusEvent) {
      if (!dialog) return;
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        (focusableIn(dialog)[0] ?? dialog).focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className={styles.overlay}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={closeLabel}
          data-modal-close=""
        >
          <CloseIcon />
        </button>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={descriptionId} className={styles.description}>
          {description}
        </p>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
