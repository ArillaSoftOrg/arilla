import styles from "./DiscoveryCard.module.css";
import { ProductImage } from "./ProductImage.tsx";

export interface DiscoveryItem {
  id: string;
  title: string;
  brand?: string;
  imageUrl: string;
  imageAlt: string;
  /** Gercek katalog urunu icin `/urun/<slug>`. Yoksa kart interactive
   * gorunmez (dead link/sahte urun sayfasi olusturulmaz). */
  href?: string;
  /** Resmin dogal en/boy orani (width/height) - varsa cropsuz gosterir. */
  aspectRatio?: number;
  /** Zamansiz, opsiyonel etiket - "2 saat once bulundu" gibi sahte
   * zaman damgasi degil (bkz. docs/pages.md). */
  badgeLabel?: string;
}

export type DiscoveryCardProps = DiscoveryItem;

/**
 * docs/pages.md "/" Faz 3: kesif izgarasi karti. Veri kaynagini bilmez -
 * gercek `discovery_slot` satirlari veya demo veri seti ayni sekli
 * doldurabilir (apps/web/app/discovery-adapter.ts). Gorsel-agirlikli,
 * baslik/marka tek satir - uzun paragraf gibi gorunmez.
 */
export function DiscoveryCard({
  title,
  brand,
  imageUrl,
  imageAlt,
  href,
  aspectRatio,
  badgeLabel,
}: DiscoveryCardProps) {
  const label = brand ? `${brand} ${title}` : title;
  const image = (
    <ProductImage
      src={imageUrl}
      alt={imageAlt}
      className={styles.image}
      style={aspectRatio ? { aspectRatio } : undefined}
    />
  );

  if (href) {
    return (
      <a href={href} className={styles.card}>
        {image}
        <span className={styles.meta}>
          {badgeLabel ? <span className={styles.badge}>{badgeLabel}</span> : null}
          <span className={styles.title}>{label}</span>
        </span>
      </a>
    );
  }

  return (
    <figure className={styles.card}>
      {image}
      <figcaption className={styles.meta}>
        {badgeLabel ? <span className={styles.badge}>{badgeLabel}</span> : null}
        <span className={styles.title}>{label}</span>
      </figcaption>
    </figure>
  );
}
