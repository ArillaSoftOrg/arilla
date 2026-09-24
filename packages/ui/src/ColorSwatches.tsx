import { useId } from "react";
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
  /** Etiketin ogesi; varsayilan `p`. Sayfa bolum basligi olarak `h2`/`h3` secebilir. */
  labelAs?: "p" | "h2" | "h3";
}

/** docs/pages.md "Diğer renkler": model_key eşleşmesi varsa. */
export function ColorSwatches({ variants, label, labelAs: LabelTag = "p" }: ColorSwatchesProps) {
  const labelId = useId();
  if (variants.length === 0) return null;
  return (
    <div className={styles.group}>
      <LabelTag id={labelId} className={styles.label}>
        {label}
      </LabelTag>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolunu dusurur. */}
      <ul className={styles.list} role="list" aria-labelledby={labelId}>
        {variants.map((variant) => (
          <li key={variant.href}>
            {variant.imageUrl ? (
              <a
                href={variant.href}
                className={styles.swatch}
                aria-label={variant.color || label}
                title={variant.color || undefined}
              >
                <img src={variant.imageUrl} alt="" className={styles.image} loading="lazy" />
              </a>
            ) : (
              <a href={variant.href} className={`${styles.swatch} ${styles.text}`}>
                {variant.color || label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
