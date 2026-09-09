import styles from "./ProductCard.module.css";

/** docs/pages.md: "Yükleniyor: iskelet kart, spinner değil." */
export function ProductCardSkeleton() {
  return (
    <div className={styles.card} aria-hidden="true">
      <div className={styles.imagePlaceholder} />
      <div className={styles.imagePlaceholder} style={{ aspectRatio: "auto", height: "1em" }} />
      <div className={styles.meta}>
        <span
          className={styles.imagePlaceholder}
          style={{ aspectRatio: "auto", height: "1.5em", width: "40%" }}
        />
      </div>
    </div>
  );
}
