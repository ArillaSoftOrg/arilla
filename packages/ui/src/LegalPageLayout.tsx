import type { ReactNode } from "react";
import styles from "./LegalPageLayout.module.css";

export interface LegalPageLayoutProps {
  title: string;
  /** Cagiran taraf tam metni verir (orn. "Son guncelleme: 17 Eylul 2026") -
   * gercek, sabit bir tarih olmali; `new Date()` ile hesaplanmaz (her
   * ziyarette "bugun guncellendi" demek yalan sinyal olur, bkz. docs/
   * sitemap.md "lastmod gercek degisiklik zamanidir"). */
  lastUpdatedLabel: string;
  children: ReactNode;
}

/**
 * docs/pages.md "/gizlilik, /kosullar, /cerez" (Faz 6): tek paylasilan
 * sarmalayici - her sayfa kendi icerigini tekrar tekrar kopyalamaz. Okuma
 * genisligi (`--content-width-reading`), agir gorsel tasarim yok.
 */
export function LegalPageLayout({ title, lastUpdatedLabel, children }: LegalPageLayoutProps) {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lastUpdated}>{lastUpdatedLabel}</p>
      <div className={styles.content}>{children}</div>
    </main>
  );
}
