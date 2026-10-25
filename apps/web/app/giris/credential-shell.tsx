import type { ReactNode } from "react";
import { SITE_BRAND } from "../site-config.ts";
import { CREDENTIAL_COPY as COPY } from "./credential-copy.ts";
import styles from "./page.module.css";

/**
 * E-posta + şifre ekranlarının ortak çerçevesi (`/giris/telefon` ile aynı
 * düzen): marka, kapat, başlık, bildirim ve alt bağlantılar.
 */
export function CredentialShell({
  titleId,
  title,
  notice,
  noticeRole = "alert",
  closeHref = "/giris",
  backHref = "/giris",
  children,
  footer,
}: {
  titleId: string;
  title: string;
  notice?: string;
  noticeRole?: "alert" | "status";
  closeHref?: string;
  /** "Diğer giriş seçenekleri" hedefi (kayıt niyetini ve `next`'i taşıyabilir). */
  backHref?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <a className={styles.brand} href="/" aria-label={`${SITE_BRAND} ana sayfa`}>
        {SITE_BRAND}
      </a>
      <a className={styles.close} href={closeHref} aria-label={`${title} ekranını kapat`}>
        ×
      </a>
      <section className={styles.panel} aria-labelledby={titleId}>
        <h1 id={titleId} className={styles.title}>
          {title}
        </h1>
        {notice ? (
          <p role={noticeRole} className={styles.notice}>
            {notice}
          </p>
        ) : null}
        {children}
        <div className={styles.linkRow}>
          {footer}
          <a className={styles.legal} href={backHref}>
            {COPY.back}
          </a>
        </div>
      </section>
    </div>
  );
}

/** `/giris` ile aynı yasal not (Hizmet Şartları + Gizlilik); hesap açılan ekranlarda gösterilir. */
export function LegalNote() {
  return (
    <p className={styles.legal}>
      Devam ederek {SITE_BRAND}'nin <a href="/kosullar">Hizmet Şartlarını</a> kabul etmiş ve{" "}
      <a href="/gizlilik">Gizlilik Politikasını</a> okumuş olursun.
    </p>
  );
}

/** `next` değerini bağlantılara taşır (yalnızca güvenli yol; sunucu yine süzer). */
export function withNext(href: string, next: string): string {
  if (!next || next === "/") return href;
  return `${href}${href.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`;
}
