import { ProductImage } from "./ProductImage.tsx";
import styles from "./TrendCollectionCard.module.css";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

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
  /** Varsayilan "lazy"; yalnizca ilk ekrandaki ilk kart "eager". */
  heroImageLoading?: "lazy" | "eager";
  /** LCP adayi olan ilk kart icin "high". */
  heroImageFetchPriority?: "high" | "low" | "auto";
};

/**
 * Editoryal trend karti (design.md "Trend kartı": kapak, baslik, urun
 * onizlemeleri). Veri kaynagini bilmez - bugun
 * `apps/web/data/demo/homepage-trends.ts`, ileride bir DB sonucu.
 *
 * Bugun trend sayfasi (`/trend/<slug>`) olmadigi icin kart baglanti DEGIL -
 * sahte href uretilmez. Rota geldiginde `href` eklenir.
 */
export function TrendCollectionCard({
  eyebrow,
  title,
  description,
  heroImageUrl,
  heroImageAlt,
  products,
  heroImageLoading = "lazy",
  heroImageFetchPriority,
}: TrendCollectionCardProps) {
  return (
    <article className={styles.card}>
      <div className={styles.frame}>
        <ProductImage
          src={heroImageUrl}
          alt={heroImageAlt}
          className={styles.heroImage}
          fit="contain"
          loading={heroImageLoading}
          fetchPriority={heroImageFetchPriority}
        />
      </div>
      <div className={styles.body}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.description}>{description}</p>
        {products && products.length > 0 ? (
          // biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur.
          <ul role="list" className={styles.productList}>
            {products.map((product) => (
              <li key={product.id} className={styles.productItem}>
                {/* Ad hemen yaninda (gizli metin) - gorsel dekoratif, alt="". */}
                <ProductImage
                  src={product.imageUrl}
                  alt=""
                  className={styles.productImage}
                  fit="contain"
                />
                <VisuallyHidden>
                  {product.brand ? `${product.brand} ${product.title}` : product.title}
                </VisuallyHidden>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
