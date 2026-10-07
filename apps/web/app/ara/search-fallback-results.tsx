import { EmptyState } from "@arilla/ui";
import styles from "./ara.module.css";
import { ResultGrid, type ResultGridItem } from "./search-results.tsx";

/**
 * Birebir eşleşme yokken gösterilen yakın sonuçlar. Gerçek sonuç gibi
 * görünmemesi için ayrı başlık, ayrı bölge ve `data-search-mode="fallback"`
 * işareti taşır; sonuç sayısı ("N sonuç") ve sıralama sekmeleri bu bölgede
 * yoktur. Metinler arayüz dilinde (sen), ALL CAPS yok, yasaklı kelime yok.
 */
export const FALLBACK_TITLE = "Aradığın ürünü bulamadık.";
export const FALLBACK_DESCRIPTION =
  "Birebir eşleşme yok. Aşağıdakiler aramana en yakın ürünler, bir göz atabilirsin.";
export const FALLBACK_LIST_HEADING = "Bunlara göz atabilirsin";
export const NO_RESULT_TITLE = "Bu aramada sonuç bulamadık.";
export const NO_RESULT_DESCRIPTION =
  "Daha genel bir arama dene: fiyat, renk ya da beden gibi ayrıntıları çıkarabilir veya farklı kelimeler kullanabilirsin.";

const HEADING_ID = "en-yakin-sonuclar";

export function SearchFallbackResults({ items }: { items: readonly ResultGridItem[] }) {
  return (
    <section className={styles.section} data-search-mode="fallback" aria-labelledby={HEADING_ID}>
      <EmptyState
        className={styles.emptyPanel}
        title={FALLBACK_TITLE}
        description={FALLBACK_DESCRIPTION}
        headingLevel={2}
      />
      <div className={styles.section}>
        <h2 id={HEADING_ID} className={styles.sectionTitle}>
          {FALLBACK_LIST_HEADING}
        </h2>
        <ResultGrid items={items} labelledBy={HEADING_ID} />
      </div>
    </section>
  );
}

/** Eşiği geçen hiçbir ürün yok: alakasız ürün göstermek yerine dürüstçe boş. */
export function SearchNoResults() {
  return (
    <section className={styles.section} data-search-mode="empty">
      <EmptyState
        className={styles.emptyPanel}
        title={NO_RESULT_TITLE}
        description={NO_RESULT_DESCRIPTION}
        headingLevel={2}
      />
    </section>
  );
}
