import styles from "./ContinueShoppingChips.module.css";
import { joinClassNames, listRole } from "./layout.ts";

export interface ContinueShoppingChipItem {
  label: string;
  meta?: string;
  imageUrl?: string;
  imageAlt?: string;
}

export interface ContinueShoppingChipsProps {
  items: readonly ContinueShoppingChipItem[];
  onSelect: (label: string) => void;
  /** Grubu adlandiran gorunur basligin id'si (tercih edilen). */
  labelledBy?: string;
  /** Gorunur baslik yoksa grubun erisilebilir adi. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Arama kutusunun altindaki hazir sorgu chip'leri. Veri cagiran taraftan
 * gelir (JSX'te tek tek hard-code edilmez). Masaustunde ortali sarilir;
 * telefonda tek satir, yatay dokunmatik kaydirma (native kaydirma cubugu
 * gizli, kaydirma calisir).
 */
export function ContinueShoppingChips({
  items,
  onSelect,
  labelledBy,
  ariaLabel,
  className,
}: ContinueShoppingChipsProps) {
  if (items.length === 0) return null;
  const hasMedia = items.some((item) => item.imageUrl);

  return (
    <ul
      // Adlandirilmis liste: ekran okuyucu "Arama fikirleri, 5 oge" der.
      // list-style:none WebKit'te liste rolunu dusurur; rol acikca verilir.
      role={listRole("ul", undefined)}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      className={joinClassNames(styles.row, hasMedia && styles.cardRow, className)}
    >
      {items.map((item) => (
        <li key={item.label} className={styles.item}>
          <button
            type="button"
            className={joinClassNames(styles.chip, hasMedia && styles.card)}
            onClick={() => onSelect(item.label)}
          >
            {item.imageUrl ? (
              <img
                src={item.imageUrl}
                alt=""
                loading="lazy"
                decoding="async"
                className={styles.thumb}
              />
            ) : null}
            <span className={styles.copy}>
              <span className={styles.label}>{item.label}</span>
              {item.meta ? <span className={styles.meta}>{item.meta}</span> : null}
            </span>
          </button>
        </li>
      ))}
      {hasMedia ? (
        <li className={styles.arrowItem} aria-hidden="true">
          <span className={styles.arrowCue}>→</span>
        </li>
      ) : null}
    </ul>
  );
}
