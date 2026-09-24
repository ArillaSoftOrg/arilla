import { formatTRY } from "./format.ts";
import styles from "./PriceDiffBlock.module.css";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

export interface PriceDiffBlockProps {
  currentPriceKurus: number;
  /** Yok veya guncel fiyattan yuksek degilse ustu cizili satir/tasarruf gosterilmez. */
  listPriceKurus: number | null;
  /** docs/copy.md `product.saving`: "{tutar} tasarruf". */
  savingLabel: (savingKurus: number) => string;
  /**
   * Ekran okuyucu icin ustu cizili fiyatin oneki ("Liste fiyatı"). Ustu
   * cizgi gorsel bir ipucu, sesli okumada kaybolur.
   */
  listPriceLabel?: string;
  /** Ekran okuyucu icin guncel fiyatin oneki ("En düşük fiyat"). */
  currentPriceLabel?: string;
}

/**
 * docs/design.md "Fiyat farkı bileşeni": "Ürünün imzası. Rozet değil,
 * tipografik bir olay." Sola hizali, kutu/golge/kenarlik yok.
 */
export function PriceDiffBlock({
  currentPriceKurus,
  listPriceKurus,
  savingLabel,
  listPriceLabel,
  currentPriceLabel,
}: PriceDiffBlockProps) {
  const hasSaving = listPriceKurus !== null && listPriceKurus > currentPriceKurus;
  const savingKurus = hasSaving ? (listPriceKurus as number) - currentPriceKurus : 0;

  return (
    <div className={styles.block}>
      {hasSaving ? (
        <span className={`${styles.listPrice} tabular-nums`}>
          {listPriceLabel ? <VisuallyHidden>{`${listPriceLabel}: `}</VisuallyHidden> : null}
          <s>{formatTRY(listPriceKurus as number)}</s>
        </span>
      ) : null}
      <span className={`${styles.currentPrice} tabular-nums`}>
        {currentPriceLabel ? <VisuallyHidden>{`${currentPriceLabel}: `}</VisuallyHidden> : null}
        {formatTRY(currentPriceKurus)}
      </span>
      {hasSaving ? (
        <span className={`${styles.saving} tabular-nums`}>{savingLabel(savingKurus)}</span>
      ) : null}
    </div>
  );
}
