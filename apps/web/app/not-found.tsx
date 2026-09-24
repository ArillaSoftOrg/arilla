import type { Metadata } from "next";
import { HOME_COPY } from "./home-copy.ts";
import actions from "./public-actions.module.css";
import { SubpageShell } from "./public-site-shell.tsx";
import styles from "./system-state.module.css";

/** Metinler docs/copy.md `error.*` - anahtarlar yorumda. */
const NOT_FOUND_COPY = {
  code: "Hata 404", // error.not_found_code
  title: "Aradığın sayfayı bulamadık.", // error.not_found
  body: "Bağlantı eskimiş ya da sayfa taşınmış olabilir. Aramaya ana sayfadan yeniden başlayabilir veya keşfedilen ürünlere göz atabilirsin.", // error.not_found_body
  homeAction: "Ana sayfaya dön", // error.home_action
} as const;

export const metadata: Metadata = {
  title: "Sayfa bulunamadı – Arilla",
  robots: { index: false },
};

/**
 * Kok 404: eslesmeyen URL'ler (`[...link]` catch-all'in `notFound()`'u
 * dahil) ve `notFound()` cagiran segmentler (`/urun/[slug]`, ...). Kok
 * layout'un icinde, segment layout'larinin yerine cizilir - bu yuzden public
 * kabugu (header + tek `<main>` + footer) burada kendisi kurar.
 *
 * Linkler yalnizca var olan route'lara: `/ara` sorgusuz anlamsiz oldugu icin
 * arama ana sayfadan baslatilir.
 */
export default function NotFound() {
  return (
    <SubpageShell>
      <div className={styles.page}>
        <p className={styles.code}>{NOT_FOUND_COPY.code}</p>
        <div className={styles.text}>
          <h1 className={styles.title}>{NOT_FOUND_COPY.title}</h1>
          <p className={styles.body}>{NOT_FOUND_COPY.body}</p>
        </div>
        <div className={actions.actions}>
          <a href="/" className={actions.primary}>
            {NOT_FOUND_COPY.homeAction}
          </a>
          <a href="/kesfet" className={actions.secondary}>
            {HOME_COPY.navDiscover}
          </a>
          <a href="/firsatlar" className={actions.secondary}>
            {HOME_COPY.navDeals}
          </a>
        </div>
      </div>
    </SubpageShell>
  );
}
