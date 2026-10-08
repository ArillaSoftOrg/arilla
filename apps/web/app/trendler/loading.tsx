import { Section, VisuallyHidden } from "@arilla/ui";
import { TREND_COPY } from "./trend-copy.ts";
import styles from "./trendler.module.css";

/** Akis (streaming) iskeleti: baslik + ilk satir kartlari; yukleniyor durumu ekran okuyucuya bildirilir. */
export default function Loading() {
  return (
    <Section aria-busy="true">
      <VisuallyHidden as="p" role="status">
        {TREND_COPY.loading}
      </VisuallyHidden>
      <div className={styles.skeletonBar} aria-hidden="true" />
      <div className={styles.grid} aria-hidden="true">
        <div className={styles.skeletonCard} />
        <div className={styles.skeletonCard} />
        <div className={styles.skeletonCard} />
      </div>
    </Section>
  );
}
