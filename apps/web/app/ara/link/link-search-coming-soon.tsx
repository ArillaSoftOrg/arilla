import { EmptyState, SearchForm } from "@arilla/ui";
import styles from "../ara.module.css";
import { LINK_SEARCH_COPY } from "./link-search-copy.ts";

/**
 * Link araması geçici olarak kapalıyken (`LINK_SEARCH_PUBLIC`) `/ara/link`
 * ve onun yükleme durumu bunu gösterir: form, bekleme ya da sonuç yok; eski
 * bağlantılar 404 vermez. Metin araması buradan sürer.
 */
export function LinkSearchComingSoon() {
  return (
    <div className={styles.page}>
      <EmptyState
        className={styles.emptyPanel}
        title={LINK_SEARCH_COPY.comingSoonTitle}
        description={LINK_SEARCH_COPY.comingSoonDescription}
        headingLevel={1}
      />
      <section className={styles.section} aria-labelledby="yeni-arama">
        <h2 id="yeni-arama" className={styles.sectionTitle}>
          {LINK_SEARCH_COPY.newSearchTitle}
        </h2>
        <div className={styles.toolbar}>
          <div className={styles.toolbarSearch}>
            <SearchForm
              placeholder={LINK_SEARCH_COPY.comingSoonPlaceholder}
              submitLabel={LINK_SEARCH_COPY.searchSubmit}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
