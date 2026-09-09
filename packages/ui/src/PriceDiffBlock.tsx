import { formatTRY } from "./format.ts";
import styles from "./PriceDiffBlock.module.css";

export interface PriceDiffBlockProps {
  currentPriceKurus: number;
  /** Yok veya guncel fiyattan yuksek degilse ustu cizili satir/tasarruf gosterilmez. */
  listPriceKurus: number | null;
  /** docs/copy.md `product.saving`: "{tutar} tasarruf". */
  savingLabel: (savingKurus: number) => string;
}

/**
 * docs/design.md "Fiyat farkı bileşeni": "Ürünün imzası. Rozet değil,
 * tipografik bir olay." Sola hizali, kutu/golge/kenarlik yok.
 */
export function PriceDiffBlock({
  currentPriceKurus,
  listPriceKurus,
  savingLabel,
}: PriceDiffBlockProps) {
  const hasSaving = listPriceKurus !== null && listPriceKurus > currentPriceKurus;
  const savingKurus = hasSaving ? (listPriceKurus as number) - currentPriceKurus : 0;

  return (
    <div className={styles.block}>
      {hasSaving ? (
        <span className={`${styles.listPrice} tabular-nums`}>
          {formatTRY(listPriceKurus as number)}
        </span>
      ) : null}
      <span className={`${styles.currentPrice} tabular-nums`}>{formatTRY(currentPriceKurus)}</span>
      {hasSaving ? (
        <span className={`${styles.saving} tabular-nums`}>{savingLabel(savingKurus)}</span>
      ) : null}
    </div>
  );
}
