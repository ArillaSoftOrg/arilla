"use client";

import { type FormEvent, type KeyboardEvent, useId, useRef } from "react";
import { Button } from "./Button.tsx";
import { resolveComposerSubmit } from "./composer-submit.ts";
import { ArrowRightIcon, CloseIcon, PlusIcon } from "./icons.tsx";
import { listRole } from "./layout.ts";
import { PhotoUploadButton } from "./PhotoUploadButton.tsx";
import { ProductCard } from "./ProductCard.tsx";
import styles from "./SearchComposer.module.css";

export interface SearchComposerPhoto {
  /** Erisilebilir ad ("Fotoğraf yükle"; yuklenirken "Benzerlerini arıyoruz"). */
  label: string;
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

/**
 * Gonderilmeden once kutuda duran fotograf (karar 0078). Verilirse Enter/Gonder,
 * metin (bos olabilir) + fotografi TEK eylemle `onSubmit`e verir; form yonlenmez.
 * Secme/yukleme mantigi cagiran tarafta (apps/web).
 */
export interface SearchComposerAttachment {
  previewUrl: string;
  /** Onizlemenin erisilebilir metni. */
  alt: string;
  removeLabel: string;
  onRemove: () => void;
  /** `true` (ya da cozulurse) donerse girdi temizlenir. Cagiran hatayi kendisi gosterir. */
  onSubmit: (text: string) => boolean | Promise<boolean>;
  /** Gonderim suruyor: girdi, kaldirma ve gonder kapali. */
  pending?: boolean;
}

/**
 * Enter yalnizca IME birlestirmesini onaylamak icinse (CJK, bazi mobil klavyeler,
 * Safari'nin `keyCode 229`'u) formu gondermemeli.
 */
export function isImeEnter(event: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.key === "Enter" && (event.isComposing === true || event.keyCode === 229);
}

export interface SearchComposerRecentProduct {
  productId: number;
  href: string;
  title: string;
  imageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
}

export interface SearchComposerProps {
  /**
   * docs/routes.md: "/ara?q=..." - SearchForm ile ayni sozlesme. Bir fonksiyon
   * (server action) verilirse form GET yerine onu calistirir (karar 0074:
   * sohbet baslatir); JS'siz de calisir.
   */
  action?: string | ((formData: FormData) => void | Promise<void>);
  /**
   * Verilirse metin gonderimi (Enter, buton, ornek cip) bu isleyiciye gider ve form
   * yonlendirmez. Isleyici kullanici hareketi SIRASINDA senkron cagrilir (yeni sekme
   * `window.open` popup engelleyiciye takilmaz). `true` donerse (ya da cozulurse) girdi temizlenir.
   */
  onSubmitText?: (text: string) => boolean | Promise<boolean>;
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
  /** Karar 0078: kutuda bekleyen, henuz gonderilmemis fotograf. */
  attachment?: SearchComposerAttachment | null;
  /** Yukleme hatasi gibi durum mesaji - role="alert", kutunun altinda. */
  statusMessage?: string | null;
  /** Devam eden islem (fotograf araniyor) - role="status", kibar duyuru. */
  busyMessage?: string | null;
  /** "Alışverişe devam et": son görüntülenen ürünler (aynı `ProductCard`, hesap sayfasıyla ortak). */
  recentProducts?: readonly SearchComposerRecentProduct[];
  chipsTitle?: string;
  /** Mağaza sayısı metni (docs/copy.md `search.offer_count`); çağıran sağlar. */
  offerCountLabel?: (count: number) => string;
  /** true ise http(s) veya www. ile baslayan girdiler kok link cozumleme rotasina gider. */
  routeProductLinks?: boolean;
}

/**
 * docs/pages.md "/": ana sayfanin ana eylemi olan buyuk arama kutusu.
 * SearchForm.tsx'in JS'siz native GET sozlesmesini korur - form onSubmit
 * normal metinde /ara?q=...'e native submit yapar (Enter dahil). Ana sayfa
 * opt-in verdiginde ürün linkleri kok catch-all cozumleme rotasina tasinir.
 * Chip tiklamasi girdiyi doldurup ayni submit'i requestSubmit() ile tetikler.
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
  attachment,
  statusMessage,
  busyMessage,
  recentProducts,
  chipsTitle,
  offerCountLabel,
  routeProductLinks = false,
  onSubmitText,
}: SearchComposerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipsTitleId = useId();
  const submittingRef = useRef(false);

  function productLinkFromInput(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isImeEnter(event.nativeEvent)) event.preventDefault();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (attachment) {
      // Fotograf + metin tek mesaj: native GET/server action yolu kullanilmaz.
      event.preventDefault();
      const text = (inputRef.current?.value ?? "").trim();
      // Metin bos olabilir (yalniz fotograf); ayni kural sohbet ici kutuda da gecerli.
      const decision = resolveComposerSubmit({
        text,
        hasImage: true,
        busy: attachment.pending || submittingRef.current,
      });
      if (decision === "noop") return;
      submittingRef.current = true;
      void Promise.resolve(attachment.onSubmit(text))
        .then((ok) => {
          if (ok && inputRef.current) inputRef.current.value = "";
        })
        .catch(() => undefined)
        .finally(() => {
          submittingRef.current = false;
        });
      return;
    }
    if (routeProductLinks) {
      const productLink = productLinkFromInput(inputRef.current?.value ?? "");
      if (productLink) {
        event.preventDefault();
        window.location.assign(`/${encodeURIComponent(productLink)}`);
        return;
      }
    }
    if (onSubmitText) {
      event.preventDefault();
      const text = (inputRef.current?.value ?? "").trim();
      if (
        resolveComposerSubmit({ text, hasImage: false, busy: submittingRef.current }) === "noop"
      ) {
        return;
      }
      submittingRef.current = true;
      void Promise.resolve(onSubmitText(text))
        .then((ok) => {
          if (ok && inputRef.current) inputRef.current.value = "";
        })
        .finally(() => {
          submittingRef.current = false;
        });
      return;
    }
    // Sohbet baslatan form (server action): cift tiklama/Enter ikinci bir sohbet acmasin.
    if (typeof action !== "string") {
      if (submittingRef.current) {
        event.preventDefault();
        return;
      }
      submittingRef.current = true;
      setTimeout(() => {
        submittingRef.current = false;
      }, 4000);
    }
  }

  return (
    <div className={styles.wrapper}>
      <search>
        <form
          ref={formRef}
          action={action}
          method={typeof action === "string" ? "get" : undefined}
          onSubmit={handleSubmit}
          className={attachment ? `${styles.box} ${styles.boxWithAttachment}` : styles.box}
          aria-busy={busyMessage || attachment?.pending ? true : undefined}
        >
          {attachment ? (
            <div className={styles.attachment}>
              <img
                className={styles.attachmentImage}
                src={attachment.previewUrl}
                alt={attachment.alt}
              />
              <button
                type="button"
                className={styles.attachmentRemove}
                aria-label={attachment.removeLabel}
                disabled={attachment.pending}
                onClick={attachment.onRemove}
              >
                <CloseIcon />
              </button>
            </div>
          ) : null}
          <input
            ref={inputRef}
            type="search"
            name={name}
            defaultValue={defaultValue}
            placeholder={placeholder}
            aria-label={inputLabel ?? placeholder}
            autoComplete="off"
            enterKeyHint={attachment ? "send" : "search"}
            readOnly={attachment?.pending}
            onKeyDown={handleKeyDown}
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
                disabled={photo.disabled || attachment?.pending}
                variant="ghost"
                className={styles.photoButton}
              />
            ) : null}
            <Button
              type="submit"
              variant="accent"
              aria-label={submitLabel}
              disabled={attachment?.pending}
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

      {recentProducts && recentProducts.length > 0 ? (
        <div className={styles.chipsSection}>
          {chipsTitle ? (
            <p id={chipsTitleId} className={styles.chipsTitle}>
              {chipsTitle}
            </p>
          ) : null}
          <ul
            // list-style:none WebKit'te liste rolunu dusurur; rol acikca verilir.
            role={listRole("ul", undefined)}
            aria-labelledby={chipsTitle ? chipsTitleId : undefined}
            className={styles.recentRow}
          >
            {recentProducts.map((item) => (
              <li key={item.productId} className={styles.recentItem}>
                <ProductCard
                  href={item.href}
                  title={item.title}
                  imageUrl={item.imageUrl}
                  minPrice={item.minPrice}
                  offerCount={item.offerCount}
                  offerCountLabel={offerCountLabel}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
