"use client";

import { useId, useRef } from "react";
import { Button } from "./Button.tsx";
import { type ContinueShoppingChipItem, ContinueShoppingChips } from "./ContinueShoppingChips.tsx";
import { ArrowRightIcon, PlusIcon } from "./icons.tsx";
import { PhotoUploadButton } from "./PhotoUploadButton.tsx";
import styles from "./SearchComposer.module.css";

export interface SearchComposerPhoto {
  /** Erisilebilir ad ("Fotoğraf yükle"; yuklenirken "Benzerlerini arıyoruz"). */
  label: string;
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export interface SearchComposerProps {
  /** docs/routes.md: "/ara?q=..." - SearchForm ile ayni sozlesme. */
  action?: string;
  name?: string;
  defaultValue?: string;
  placeholder: string;
  /** Girdinin erisilebilir adi; verilmezse `placeholder`. */
  inputLabel?: string;
  submitLabel: string;
  autoFocus?: boolean;
  /** Fotograf yukleme - verilirse kutunun icinde ikon dugmesi olarak cizilir.
   * Yukleme mantigi cagiran tarafta (apps/web). */
  photo?: SearchComposerPhoto;
  /** Yukleme hatasi gibi durum mesaji - role="alert", kutunun altinda. */
  statusMessage?: string | null;
  /** Devam eden islem (fotograf araniyor) - role="status", kibar duyuru. */
  busyMessage?: string | null;
  chips?: readonly ContinueShoppingChipItem[];
  chipsTitle?: string;
}

/**
 * docs/pages.md "/": ana sayfanin ana eylemi olan buyuk arama kutusu.
 * SearchForm.tsx'in JS'siz native GET sozlesmesini korur - form onSubmit
 * handler'i yok, tarayici /ara?q=...'e native submit yapar (Enter dahil).
 * Chip tiklamasi girdiyi doldurup ayni native submit'i requestSubmit() ile
 * tetikler, yeni bir API icat edilmez.
 *
 * Gorunum (design.md "Kutu modeli"): `--radius-lg` yuzey, `--line-strong`
 * kontrol siniri + `--shadow-xs` dinlenme, `focus-within`'de `--shadow-sm`;
 * girdi odaginda kutu `--focus-ring` tasir (girdinin kendi outline'i yok).
 */
export function SearchComposer({
  action = "/ara",
  name = "q",
  defaultValue,
  placeholder,
  inputLabel,
  submitLabel,
  autoFocus = false,
  photo,
  statusMessage,
  busyMessage,
  chips,
  chipsTitle,
}: SearchComposerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipsTitleId = useId();

  function handleChipSelect(label: string) {
    if (inputRef.current) {
      inputRef.current.value = label;
    }
    formRef.current?.requestSubmit();
  }

  return (
    <div className={styles.wrapper}>
      <search>
        <form
          ref={formRef}
          action={action}
          method="get"
          className={styles.box}
          aria-busy={busyMessage ? true : undefined}
        >
          <input
            ref={inputRef}
            type="search"
            name={name}
            defaultValue={defaultValue}
            placeholder={placeholder}
            aria-label={inputLabel ?? placeholder}
            autoComplete="off"
            enterKeyHint="search"
            // biome-ignore lint/a11y/noAutofocus: opt-in prop, sadece ana sayfada true.
            autoFocus={autoFocus}
            className={styles.input}
          />
          <div className={styles.actions}>
            {photo ? (
              <PhotoUploadButton
                iconOnly
                icon={<PlusIcon />}
                label={photo.label}
                onFileSelected={photo.onFileSelected}
                disabled={photo.disabled}
                variant="ghost"
                className={styles.photoButton}
              />
            ) : null}
            <Button
              type="submit"
              variant="accent"
              aria-label={submitLabel}
              className={styles.submit}
            >
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
      <p role="status" className={styles.busy}>
        {busyMessage ?? ""}
      </p>

      {chips && chips.length > 0 ? (
        <div className={styles.chipsSection}>
          {chipsTitle ? (
            <p id={chipsTitleId} className={styles.chipsTitle}>
              {chipsTitle}
            </p>
          ) : null}
          <ContinueShoppingChips
            items={chips}
            onSelect={handleChipSelect}
            labelledBy={chipsTitle ? chipsTitleId : undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
