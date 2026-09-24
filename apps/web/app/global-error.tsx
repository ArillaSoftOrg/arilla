"use client";

import "./globals.css";
import { useEffect } from "react";
import actions from "./public-actions.module.css";
import styles from "./system-state.module.css";

/** Metinler docs/copy.md `error.*` - anahtarlar yorumda. */
const GLOBAL_ERROR_COPY = {
  documentTitle: "Bir hata oluştu – Arilla", // error.document_title
  title: "Arilla şu an açılamadı.", // error.global_title
  body: "Bir şeyler ters gitti. Tekrar dener misin?", // error.generic
  retry: "Tekrar dene", // action.retry
  homeAction: "Ana sayfaya dön", // error.home_action
} as const;

/**
 * Kok layout'un kendisi hata verdiginde devreye girer ve onun yerine gecer:
 * kendi `<html lang="tr">` / `<body>`'sini cizer (Next 16 error.md "Global
 * Error"). Kok layout'un stilleri gelmedigi icin `globals.css` (belirtecler +
 * depodaki font) burada ayrica import edilir. Tema cerezi okunmaz; tema
 * cihaz tercihinden (`prefers-color-scheme`) gelir. `metadata` desteklenmez,
 * baslik React `<title>` ile verilir. Bilincli olarak minimal: kabuk,
 * oturum ve veritabani bagimliligi yok; `@arilla/ui` de yuklenmez.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="tr">
      <body>
        <title>{GLOBAL_ERROR_COPY.documentTitle}</title>
        <main className={`${styles.bareShell} ${styles.gutter}`}>
          <div className={styles.page}>
            <div className={styles.text}>
              <h1 className={styles.title}>{GLOBAL_ERROR_COPY.title}</h1>
              <p className={styles.body}>{GLOBAL_ERROR_COPY.body}</p>
            </div>
            <div className={actions.actions}>
              <button type="button" className={actions.primary} onClick={() => retry()}>
                {GLOBAL_ERROR_COPY.retry}
              </button>
              <a href="/" className={actions.secondary}>
                {GLOBAL_ERROR_COPY.homeAction}
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
