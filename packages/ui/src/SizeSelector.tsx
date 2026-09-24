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
  /** Listenin erisilebilir adi (gorunur etiketin id'si). */
  "aria-labelledby"?: string;
}

/**
 * docs/pages.md "Beden seçici + rozet". Kisisellestirilmis "senin bedenin"
 * isareti burada yok - kullanici oturumu (E1/E2) henuz mevcut degil.
 *
 * Stoktaki beden bilgi amacli (etkilesimsiz, --line); olmayan beden
 * `onNotifyMe` varsa dugmedir (--line-strong, WCAG 1.4.11). `title`
 * dokunmatik ve ekran okuyucuda guvenilir olmadigindan durum ayrica
 * `aria-label` ile de soylenir.
 */
export function SizeSelector({
  sizes,
  unavailableLabel,
  onNotifyMe,
  notifyMeLabel,
  "aria-labelledby": labelledBy,
}: SizeSelectorProps) {
  if (sizes.length === 0) return null;
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolunu dusurur.
    <ul className={styles.list} role="list" aria-labelledby={labelledBy}>
      {sizes.map((size) => {
        if (size.available) {
          return (
            <li key={size.sizeNorm} className={styles.size}>
              {size.label}
            </li>
          );
        }
        if (onNotifyMe) {
          const hint = notifyMeLabel ?? unavailableLabel;
          return (
            <li key={size.sizeNorm}>
              <button
                type="button"
                className={`${styles.size} ${styles.unavailable} ${styles.button}`}
                title={hint}
                aria-label={`${size.label}: ${unavailableLabel}. ${hint}`}
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
            aria-label={`${size.label}: ${unavailableLabel}`}
          >
            {size.label}
          </li>
        );
      })}
    </ul>
  );
}
