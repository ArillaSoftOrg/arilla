"use client";

import type { ReactNode } from "react";
import { useRef } from "react";
import { Button } from "./Button.tsx";
import { type ContinueShoppingChipItem, ContinueShoppingChips } from "./ContinueShoppingChips.tsx";
import { ArrowRightIcon } from "./icons.tsx";
import styles from "./SearchComposer.module.css";

export interface SearchComposerProps {
  /** docs/routes.md: "/ara?q=..." - SearchForm ile ayni sozlesme. */
  action?: string;
  name?: string;
  defaultValue?: string;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  /** Fotograf yukleme tetikleyicisi - apps/web mevcut upload akisini buraya baglar. */
  photoTrigger?: ReactNode;
  /** Yukleme hatasi gibi durum mesaji - role="alert", kutunun altinda tam genislik. */
  statusMessage?: string | null;
  chips?: readonly ContinueShoppingChipItem[];
  chipsTitle?: string;
  chipsAriaLabel?: string;
}

/**
 * docs/pages.md "/": buyutulmus, premium arama kutusu (karar 0025).
 * SearchForm.tsx'in JS'siz native GET sozlesmesini korur - form onSubmit
 * handler'i yok, tarayici /ara?q=...'e native submit yapar. Chip tiklamasi
 * da ayni native submit'i requestSubmit() ile tetikler, yeni bir API
 * icat edilmez.
 */
export function SearchComposer({
  action = "/ara",
  name = "q",
  defaultValue,
  placeholder,
  submitLabel,
  autoFocus = false,
  photoTrigger,
  statusMessage,
  chips,
  chipsTitle,
  chipsAriaLabel,
}: SearchComposerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChipSelect(label: string) {
    if (inputRef.current) {
      inputRef.current.value = label;
    }
    formRef.current?.requestSubmit();
  }

  return (
    <div className={styles.wrapper}>
      <search>
        <form ref={formRef} action={action} method="get" className={styles.box}>
          <input
            ref={inputRef}
            type="text"
            name={name}
            defaultValue={defaultValue}
            placeholder={placeholder}
            aria-label={placeholder}
            // biome-ignore lint/a11y/noAutofocus: opt-in prop, sadece ana sayfada true.
            autoFocus={autoFocus}
            className={styles.input}
          />
          <div className={styles.actions}>
            {photoTrigger ? <div className={styles.photoSlot}>{photoTrigger}</div> : null}
            <Button type="submit" variant="accent" aria-label={submitLabel}>
              <span className={styles.submitLabel}>{submitLabel}</span>
              <ArrowRightIcon />
            </Button>
          </div>
        </form>
      </search>

      {statusMessage ? (
        <p role="alert" className={styles.status}>
          {statusMessage}
        </p>
      ) : null}

      {chips && chips.length > 0 ? (
        <div className={styles.chipsSection}>
          {chipsTitle ? <p className={styles.chipsTitle}>{chipsTitle}</p> : null}
          <ContinueShoppingChips
            items={chips}
            onSelect={handleChipSelect}
            ariaLabel={chipsAriaLabel ?? chipsTitle ?? ""}
          />
        </div>
      ) : null}
    </div>
  );
}
