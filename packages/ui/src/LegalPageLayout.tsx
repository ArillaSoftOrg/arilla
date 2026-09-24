import type { ReactNode } from "react";
import styles from "./LegalPageLayout.module.css";

export interface LegalPageLayoutProps {
  title: string;
  /** Cagiran taraf tam metni verir (orn. "Son guncelleme: 17 Eylul 2026") -
   * gercek, sabit bir tarih olmali; `new Date()` ile hesaplanmaz (her
   * ziyarette "bugun guncellendi" demek yalan sinyal olur, bkz. docs/
   * sitemap.md "lastmod gercek degisiklik zamanidir"). Faz 8.1: istege
   * bagli - /iletisim gibi bilgi sayfasinin guncelleme tarihi yoktur. */
  lastUpdatedLabel?: string;
  children: ReactNode;
}

/**
 * docs/pages.md "/gizlilik, /kosullar, /cerez" (Faz 6): tek paylasilan
 * sarmalayici - her sayfa kendi icerigini tekrar tekrar kopyalamaz. Okuma
 * genisligi (`--content-width-reading`), agir gorsel tasarim yok.
 *
 * Faz 1B: `<main>` ve yatay kenar boslugu public site kabugundan gelir
 * (`<main id="icerik">` + `Container`); bu bilesen yalnizca okuma genisligini
 * uygular, ikinci bir `<main>` uretmez.
 *
 * Icerik (`children`) duz HTML'dir: `section`, `h2`, `h3`, `p`, `ul`, `a`
 * burada tek yerde bicimlenir - sayfalar satir ici stil yazmaz.
 */
export function LegalPageLayout({ title, lastUpdatedLabel, children }: LegalPageLayoutProps) {
  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        {lastUpdatedLabel ? <p className={styles.lastUpdated}>{lastUpdatedLabel}</p> : null}
      </header>
      <div className={styles.content}>{children}</div>
    </article>
  );
}
