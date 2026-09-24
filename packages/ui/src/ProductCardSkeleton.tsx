import styles from "./ProductCardSkeleton.module.css";

/**
 * docs/pages.md: "Yükleniyor: iskelet kart, spinner değil." `ProductCard`
 * ile ayni kutu ve oranlar - iskeletten gercek karta geciste duzen kaymaz.
 * Dekoratiftir (`aria-hidden`); yukleme durumunu cagiran sayfa ekran
 * okuyucuya ayrica bildirir.
 */
export function ProductCardSkeleton() {
  return (
    <div className={styles.card} aria-hidden="true">
      <div className={`${styles.block} ${styles.media}`} />
      <div className={styles.body}>
        <div className={`${styles.block} ${styles.line}`} />
        <div className={`${styles.block} ${styles.line} ${styles.lineShort}`} />
        <div className={`${styles.block} ${styles.price}`} />
      </div>
    </div>
  );
}
