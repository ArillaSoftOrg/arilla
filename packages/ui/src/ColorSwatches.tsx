import styles from "./ColorSwatches.module.css";

export interface ColorSwatchOption {
  href: string;
  color: string;
  imageUrl: string | null;
}

export interface ColorSwatchesProps {
  variants: readonly ColorSwatchOption[];
  /** docs/copy.md `product.other_colors`: "Diğer renkler". */
  label: string;
}

/** docs/pages.md "Diğer renkler": model_key eşleşmesi varsa. */
export function ColorSwatches({ variants, label }: ColorSwatchesProps) {
  if (variants.length === 0) return null;
  return (
    <div>
      <p>{label}</p>
      <div className={styles.list}>
        {variants.map((variant) =>
          variant.imageUrl ? (
            <a key={variant.href} href={variant.href}>
              <img
                src={variant.imageUrl}
                alt={variant.color}
                className={styles.swatch}
                loading="lazy"
              />
            </a>
          ) : (
            <a key={variant.href} href={variant.href} className={styles.swatch}>
              {variant.color}
            </a>
          ),
        )}
      </div>
    </div>
  );
}
