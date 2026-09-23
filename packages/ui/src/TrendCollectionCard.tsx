import { ProductImage } from "./ProductImage.tsx";
import styles from "./TrendCollectionCard.module.css";

export interface TrendCollectionProduct {
  id: string;
  title: string;
  brand?: string;
  imageUrl: string;
  imageAlt: string;
}

export interface TrendCollection {
  id: string;
  eyebrow?: string;
  title: string;
  description: string;
  heroImageUrl: string;
  heroImageAlt: string;
  products?: readonly TrendCollectionProduct[];
}

export type TrendCollectionCardProps = TrendCollection & {
  /** Faz 7: ilk ekrandaki kartlar icin "eager"; varsayilan "lazy". */
  heroImageLoading?: "lazy" | "eager";
};

/**
 * docs/pages.md "/" Faz 2: editorial kesif karti. Veri kaynagini bilmez -
 * bugun `apps/web/data/demo/homepage-trends.ts` dolduruyor, ileride ayni
 * sekli bir DB/API sonucu doldurabilir (CLAUDE.md kural 6: is mantigi
 * disarida, bilesen sadece sunum).
 */
export function TrendCollectionCard({
  eyebrow,
  title,
  description,
  heroImageUrl,
  heroImageAlt,
  products,
  heroImageLoading,
}: TrendCollectionCardProps) {
  return (
    <article className={styles.card}>
      <ProductImage
        src={heroImageUrl}
        alt={heroImageAlt}
        className={styles.heroImage}
        loading={heroImageLoading}
      />
      <div className={styles.body}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.description}>{description}</p>
        {products && products.length > 0 ? (
          <ul className={styles.productList}>
            {products.map((product) => (
              <li key={product.id} className={styles.productItem}>
                <ProductImage
                  src={product.imageUrl}
                  alt={product.imageAlt}
                  className={styles.productImage}
                />
                <span className={styles.productLabel}>
                  {product.brand ? `${product.brand} ${product.title}` : product.title}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
