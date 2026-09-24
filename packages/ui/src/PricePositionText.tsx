import styles from "./PricePositionText.module.css";

export interface PricePositionTextProps {
  /** 0-2 hazir cumle - hangi cumlelerin dahil edilecegine sayfa karar verir. */
  lines: readonly string[];
}

/** docs/pages.md "Fiyat konumu cümlesi": product_price_stats'tan turetilmis. */
export function PricePositionText({ lines }: PricePositionTextProps) {
  if (lines.length === 0) return null;
  return (
    <div className={styles.block}>
      {lines.map((line) => (
        <p key={line} className={styles.line}>
          {line}
        </p>
      ))}
    </div>
  );
}
