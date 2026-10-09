import { Section, VisuallyHidden } from "@arilla/ui";
import { TREND_COPY } from "./trend-copy.ts";
import styles from "./trendler.module.css";

/**
 * Liste icin akis (streaming) iskeleti: baslik + ilk satir kartlari. `loading.tsx` DEGIL:
 * segment seviyesinde olsaydi `[slug]` icin de akisi baslatir, 404 durum kodu 200 kalirdi.
 */
export function TrendlerSkeleton() {
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
