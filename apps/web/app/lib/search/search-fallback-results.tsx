import { EmptyState } from "@arilla/ui";
import type { ReactNode } from "react";
import styles from "./search.module.css";
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

export function SearchFallbackResults({
  items,
  extra,
}: {
  items: readonly ResultGridItem[];
  /** Aynı ızgaranın sonuna eklenen `<li>`ler (karar 0106). */
  extra?: ReactNode;
}) {
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
        <ResultGrid items={items} labelledBy={HEADING_ID} extra={extra} />
      </div>
    </section>
  );
}

/** Eşiği geçen hiçbir ürün yok: alakasız ürün göstermek yerine dürüstçe boş. */
/** Karar 0206: katalog taramasi suresinde bitmediyse "urun yok" DENMEZ; bos sonuc gercek olmayabilir. */
export const INCOMPLETE_TITLE = "Arama süresinde tamamlanamadı.";
export const INCOMPLETE_DESCRIPTION =
  "Katalog taraması bu sefer bitmedi, bu yüzden ürün olmadığını söyleyemem. Biraz sonra tekrar dene ya da aramayı başka kelimelerle yaz.";

export function SearchNoResults({ incomplete = false }: { incomplete?: boolean } = {}) {
  return (
    <section className={styles.section} data-search-mode={incomplete ? "incomplete" : "empty"}>
      <EmptyState
        className={styles.emptyPanel}
        title={incomplete ? INCOMPLETE_TITLE : NO_RESULT_TITLE}
        description={incomplete ? INCOMPLETE_DESCRIPTION : NO_RESULT_DESCRIPTION}
        headingLevel={2}
      />
    </section>
  );
}
