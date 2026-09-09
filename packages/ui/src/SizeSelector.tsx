import styles from "./SizeSelector.module.css";

export interface SizeSelectorOption {
  sizeNorm: string;
  label: string;
  available: boolean;
}

export interface SizeSelectorProps {
  sizes: readonly SizeSelectorOption[];
  /** docs/copy.md `product.size_unavailable`: "Bu beden şu an yok". */
  unavailableLabel: string;
}

/**
 * docs/pages.md "Beden seçici + rozet". Kisisellestirilmis "senin bedenin"
 * isareti burada yok - kullanici oturumu (E1/E2) henuz mevcut degil.
 */
export function SizeSelector({ sizes, unavailableLabel }: SizeSelectorProps) {
  if (sizes.length === 0) return null;
  return (
    <ul className={styles.list}>
      {sizes.map((size) => (
        <li
          key={size.sizeNorm}
          className={size.available ? styles.size : `${styles.size} ${styles.unavailable}`}
          title={size.available ? undefined : unavailableLabel}
        >
          {size.label}
        </li>
      ))}
    </ul>
  );
}
