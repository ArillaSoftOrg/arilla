import { formatTRY } from "./format.ts";
import styles from "./ProductCard.module.css";

export interface ProductCardProps {
  href: string;
  title: string;
  imageUrl: string | null;
  /** Kurus cinsinden, docs/schema.sql: para asla float degil. */
  minPrice: number | null;
  offerCount: number;
  /** docs/copy.md `search.tab_deals` vb. cagiran taraf saglar - burada sabit metin yok. */
  offerCountLabel: (count: number) => string;
}

/** docs/pages.md "Ürün kartı": foto, başlık, fiyat, mağaza sayısı. */
export function ProductCard({
  href,
  title,
  imageUrl,
  minPrice,
  offerCount,
  offerCountLabel,
}: ProductCardProps) {
  return (
    <a href={href} className={styles.card}>
      {imageUrl ? (
        <img src={imageUrl} alt="" className={styles.image} loading="lazy" />
      ) : (
        <div className={styles.imagePlaceholder} aria-hidden="true" />
      )}
      <p className={styles.title}>{title}</p>
      <div className={styles.meta}>
        <span className={`${styles.price} tabular-nums`}>
          {minPrice === null ? "—" : formatTRY(minPrice)}
        </span>
        <span className={styles.offerCount}>{offerCountLabel(offerCount)}</span>
      </div>
    </a>
  );
}
