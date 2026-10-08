import { ProductCardSkeleton, Section, VisuallyHidden } from "@arilla/ui";
import { TREND_COPY } from "../trend-copy.ts";
import styles from "../trendler.module.css";

const SKELETON_COUNT = 8;
const SKELETON_KEYS = Array.from({ length: SKELETON_COUNT }, (_, index) => `s${index}`);

export default function Loading() {
  return (
    <Section aria-busy="true">
      <VisuallyHidden as="p" role="status">
        {TREND_COPY.loadingDetail}
      </VisuallyHidden>
      <div className={styles.detail} aria-hidden="true">
        <div className={styles.skeletonBar} />
        <div className={styles.heroMedia}>
          <div className={styles.heroPlaceholder} />
        </div>
        <div className={styles.products}>
          {SKELETON_KEYS.map((key) => (
            <ProductCardSkeleton key={key} />
          ))}
        </div>
      </div>
    </Section>
  );
}
