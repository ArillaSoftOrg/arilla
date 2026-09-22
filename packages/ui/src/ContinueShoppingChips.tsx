import styles from "./ContinueShoppingChips.module.css";

export interface ContinueShoppingChipItem {
  label: string;
}

export interface ContinueShoppingChipsProps {
  items: readonly ContinueShoppingChipItem[];
  onSelect: (label: string) => void;
  ariaLabel: string;
}

/**
 * docs/pages.md "/" Faz 1: hero altinda kucuk devam alani, DATA olarak
 * tanimli chip'ler - JSX'te tek tek hard-code edilmez (cagiran taraf saglar).
 */
export function ContinueShoppingChips({ items, onSelect, ariaLabel }: ContinueShoppingChipsProps) {
  if (items.length === 0) return null;

  return (
    <fieldset aria-label={ariaLabel} className={styles.row}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={styles.chip}
          onClick={() => onSelect(item.label)}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
