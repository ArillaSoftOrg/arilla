import type { Metadata } from "next";
import { HOME_COPY } from "./home-copy.ts";
import { NotFoundRecoveryActions } from "./not-found-recovery-actions-client.tsx";
import { SubpageShell } from "./public-site-shell.tsx";
import styles from "./system-state.module.css";

/** Metinler docs/copy.md `error.*` - anahtarlar yorumda. */
const NOT_FOUND_COPY = {
  eyebrow: "Sayfa bulunamadı",
  title: "Burada aradığın sayfayı bulamadık.", // error.not_found
  body: "Bağlantı değişmiş, taşınmış ya da henüz yayına alınmamış olabilir. Arilla'da aramaya devam etmek için aşağıdaki yollardan birini deneyebilirsin.", // error.not_found_body
  homeAction: "Aramaya dön", // error.home_action
  backAction: "Önceki sayfaya dön",
  hint: "İstersen ürünü yeniden arayabilir, öne çıkanlara bakabilir veya arama yollarını inceleyebilirsin.",
  technicalTitle: "Site bilgileri",
  technicalBody: "Site haritası ve tarama dosyaları teknik kontroller için burada.",
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
        <section className={styles.notFoundHero} aria-labelledby="not-found-title">
          <div className={styles.notFoundMark} aria-hidden="true">
            <span />
            <span />
          </div>
          <p className={styles.code}>{NOT_FOUND_COPY.eyebrow}</p>
          <div className={styles.text}>
            <h1 id="not-found-title" className={styles.title}>
              {NOT_FOUND_COPY.title}
            </h1>
            <p className={styles.body}>{NOT_FOUND_COPY.body}</p>
          </div>
          <NotFoundRecoveryActions
            homeHref="/"
            homeLabel={NOT_FOUND_COPY.homeAction}
            backLabel={NOT_FOUND_COPY.backAction}
            links={[
              { href: "/#trendler", label: HOME_COPY.navTrends },
              { href: "/kesfet", label: HOME_COPY.navDiscover },
              { href: "/#nasil-calisir", label: HOME_COPY.navHowItWorks },
            ]}
          />
          <p className={styles.hint}>{NOT_FOUND_COPY.hint}</p>
        </section>
        <section className={styles.technicalLinks} aria-labelledby="not-found-technical-title">
          <h2 id="not-found-technical-title" className={styles.technicalTitle}>
            {NOT_FOUND_COPY.technicalTitle}
          </h2>
          <p className={styles.technicalBody}>{NOT_FOUND_COPY.technicalBody}</p>
          <div className={styles.inlineLinks}>
            <a href="/sitemap.xml">Sitemap</a>
            <a href="/sitemap-sayfalar.xml">Sayfa haritası</a>
            <a href="/robots.txt">robots.txt</a>
          </div>
        </section>
      </div>
    </SubpageShell>
  );
}
