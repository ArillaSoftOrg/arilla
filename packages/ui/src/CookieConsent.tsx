"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import styles from "./CookieConsent.module.css";
import { CloseIcon } from "./icons.tsx";

/**
 * Karar 0038: cerez rizasi arayuz parcalari. Durum ve server action'lar
 * cagirandadir (apps/web); bu dosya yalnizca gorunumu ve erisilebilirligi
 * tasir.
 *
 * Esit agirlik kurali (docs/kvkk.md, legal pack 07): banner'daki uc eylem
 * AYNI `.action` sinifini kullanir - reddet, yonet ve kabul arasinda renk,
 * boyut veya siralama ile yonlendirme yapilmaz.
 */

export interface ConsentLink {
  label: string;
  href: string;
}

/** Banner ve paneldeki eylem dugmeleri/linkleri icin tek sinif. */
export const consentActionClassName: string = styles.action ?? "";

/** Banner eylem grubunun kapsayicisi (telefonda alt alta, genis ekranda yan yana) - cagiranin `<form>`'u alir. */
export const consentActionGroupClassName: string = styles.actions ?? "";

export interface CookiePreferencesLayoutProps {
  /** Erisilebilir grup adi (fieldset legend, gorsel olarak gizli degil - panel basligini tekrar etmez). */
  legend?: string;
  /** `CookieCategoryField` ogeleri. */
  categories: ReactNode;
  /** Kaydet / Reddet / Kabul dugmeleri - hepsi `consentActionClassName`. */
  actions: ReactNode;
  /** Kayit sonrasi durum metni (`aria-live`). */
  status?: string | null;
}

/**
 * Panelde ve /cerez#tercihler'de ortak kategori listesi. `<form>` cagirandadir
 * (server action veya istemci sarmalayicisi); bu bilesen yalnizca icerigi dizer.
 */
export function CookiePreferencesLayout({
  legend,
  categories,
  actions,
  status,
}: CookiePreferencesLayoutProps) {
  return (
    <div className={styles.form}>
      <fieldset className={styles.categories}>
        {legend ? <legend className={styles.categoryTitle}>{legend}</legend> : null}
        {categories}
      </fieldset>
      <div className={styles.formActions}>{actions}</div>
      <p className={styles.status} aria-live="polite">
        {status ?? ""}
      </p>
    </div>
  );
}

export interface CookieBannerProps {
  title: string;
  body: string;
  /** Cerez Politikasi, Gizlilik, KVKK. */
  links: readonly ConsentLink[];
  linksLabel: string;
  /** Uc eylem; cagiran kapsayiciyi `consentActionGroupClassName`, ogeleri `consentActionClassName` ile bicimler. */
  actions: ReactNode;
}

/**
 * Modal DEGIL (karar 0002): icerigi kapatmaz, odak tuzagi ve kaydirma kilidi
 * yok. `position: sticky` ile sayfanin sonunda durur - kaydirirken gorunumun
 * altina yapisir, sayfa sonunda footer'in altina yerlesir ve onu ortmez. Esc
 * banner'i gizlemez: tercih yapilana kadar gorunur kalir.
 */
export function CookieBanner({ title, body, links, linksLabel, actions }: CookieBannerProps) {
  const titleId = useId();
  return (
    <section className={styles.banner} aria-labelledby={titleId}>
      <div className={styles.bannerInner}>
        <div className={styles.bannerText}>
          <h2 id={titleId} className={styles.bannerTitle}>
            {title}
          </h2>
          <p className={styles.bannerBody}>{body}</p>
          <nav aria-label={linksLabel}>
            {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
            <ul role="list" className={styles.linkList}>
              {links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className={styles.inlineLink}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        {actions}
      </div>
    </section>
  );
}

export interface CookieCategoryFieldProps {
  /** Form alan adi (`functional`, `analytics`, `marketing`, `necessary`). */
  name: string;
  title: string;
  body: string;
  /** Kategoride bugun hicbir teknoloji yoksa gosterilen durust not. */
  note?: string;
  defaultChecked: boolean;
  /** Kesinlikle gerekli kategori: kilitli, her zaman acik. */
  locked?: boolean;
  lockedLabel?: string;
}

export function CookieCategoryField({
  name,
  title,
  body,
  note,
  defaultChecked,
  locked = false,
  lockedLabel,
}: CookieCategoryFieldProps) {
  const inputId = useId();
  const bodyId = useId();
  return (
    <div className={styles.category}>
      <div className={styles.categoryHead}>
        <label htmlFor={inputId} className={styles.categoryTitle}>
          {title}
        </label>
        <input
          id={inputId}
          type="checkbox"
          name={locked ? undefined : name}
          className={styles.checkbox}
          defaultChecked={locked ? true : defaultChecked}
          disabled={locked}
          aria-describedby={bodyId}
        />
      </div>
      <p id={bodyId} className={styles.categoryBody}>
        {body}
        {locked && lockedLabel ? <span className={styles.categoryNote}> {lockedLabel}</span> : null}
        {note ? <span className={styles.categoryNote}> {note}</span> : null}
      </p>
    </div>
  );
}

export interface ConsentDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  closeLabel: string;
  children: ReactNode;
}

/**
 * Tercih paneli: yerel `<dialog>` + `showModal()`. Tarayici arka plani
 * `inert` yapar (odak tuzagi yalnizca modal acikken), Esc yalnizca paneli
 * kapatir - riza kaydedilmedigi icin banner acik kalir. Kapaninca odak acan
 * ogeye doner.
 */
export function ConsentDialog({
  open,
  onClose,
  title,
  description,
  closeLabel,
  children,
}: ConsentDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={() => {
        if (openerRef.current?.isConnected) openerRef.current.focus();
        openerRef.current = null;
        onClose();
      }}
    >
      <div className={styles.dialogInner}>
        <button
          type="button"
          className={styles.close}
          onClick={() => dialogRef.current?.close()}
          aria-label={closeLabel}
        >
          <CloseIcon />
        </button>
        <h2 id={titleId} className={styles.dialogTitle}>
          {title}
        </h2>
        <p id={descriptionId} className={styles.dialogDescription}>
          {description}
        </p>
        {open ? children : null}
      </div>
    </dialog>
  );
}
