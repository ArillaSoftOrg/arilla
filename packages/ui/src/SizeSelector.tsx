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
  /** E2: verilirse olmayan bedenler tıklanabilir olur (size_restock alarmı). */
  onNotifyMe?: (sizeNorm: string) => void;
  notifyMeLabel?: string;
}

/**
 * docs/pages.md "Beden seçici + rozet". Kisisellestirilmis "senin bedenin"
 * isareti burada yok - kullanici oturumu (E1/E2) henuz mevcut degil.
 */
export function SizeSelector({
  sizes,
  unavailableLabel,
  onNotifyMe,
  notifyMeLabel,
}: SizeSelectorProps) {
  if (sizes.length === 0) return null;
  return (
    <ul className={styles.list}>
      {sizes.map((size) => {
        if (size.available) {
          return (
            <li key={size.sizeNorm} className={styles.size}>
              {size.label}
            </li>
          );
        }
        if (onNotifyMe) {
          return (
            <li key={size.sizeNorm}>
              <button
                type="button"
                className={`${styles.size} ${styles.unavailable}`}
                title={notifyMeLabel ?? unavailableLabel}
                onClick={() => onNotifyMe(size.sizeNorm)}
              >
                {size.label}
              </button>
            </li>
          );
        }
        return (
          <li
            key={size.sizeNorm}
            className={`${styles.size} ${styles.unavailable}`}
            title={unavailableLabel}
          >
            {size.label}
          </li>
        );
      })}
    </ul>
  );
}
