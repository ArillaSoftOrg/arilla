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
  /** Resmin dogal en/boy orani (width/height) - varsa kirpmadan, kendi
   * oraninda gosterilir. Yoksa kare kutu + `contain`. */
  aspectRatio?: number;
  /** Zamansiz, opsiyonel etiket - "2 saat once bulundu" gibi sahte
   * zaman damgasi degil (bkz. docs/pages.md). */
  badgeLabel?: string;
  /** Cagiran tarafca bicimlendirilmis fiyat (orn. `formatTRY`). Yalnizca
   * gercek veriden gelir; demo veri fiyat tasimaz. */
  priceLabel?: string;
  /** Fiyatin yanindaki kisa meta (orn. "3 mağaza"). */
  metaLabel?: string;
}

export type DiscoveryCardProps = DiscoveryItem & {
  /** Varsayilan "lazy"; kesif izgarasi her zaman ilk ekranin altindadir. */
  imageLoading?: "lazy" | "eager";
};

/**
 * Kesif izgarasi karti (ana sayfa `#kesfet` ve `/kesfet` ayni karti
 * kullanir). Veri kaynagini bilmez - gercek `discovery_slot` satirlari veya
 * demo veri seti ayni sekli doldurur (apps/web/app/discovery-adapter.ts).
 *
 * Urun fotografi hakimdir: gorsel `--surface-raised` zeminli, ince `--line`
 * cerceveli bir kutuda, bilinen oraninda ve `contain` ile - anlamsiz kirpma
 * yok (design.md "Ürün fotoğrafı ve koyu tema"). Metin gorselin altinda,
 * en fazla iki satir.
 */
export function DiscoveryCard({
  title,
  brand,
  imageUrl,
  imageAlt,
  href,
  aspectRatio,
  badgeLabel,
  priceLabel,
  metaLabel,
  imageLoading = "lazy",
}: DiscoveryCardProps) {
  const frame = (
    <span className={styles.frame}>
      <ProductImage
        src={imageUrl}
        // Baglantili kartta baslik zaten baglanti metninde - gorsel dekoratif,
        // ekran okuyucu adi iki kez okumaz (ProductCard ile ayni kural).
        alt={href ? "" : imageAlt}
        className={styles.image}
        aspectRatio={aspectRatio ?? 1}
        fit="contain"
        loading={imageLoading}
      />
    </span>
  );

  const meta = (
    <>
      {badgeLabel ? <span className={styles.badge}>{badgeLabel}</span> : null}
      {brand ? <span className={styles.brand}>{brand}</span> : null}
      <span className={styles.title}>{title}</span>
      {priceLabel || metaLabel ? (
        <span className={styles.priceRow}>
          {priceLabel ? <span className={styles.price}>{priceLabel}</span> : null}
          {metaLabel ? <span className={styles.metaLabel}>{metaLabel}</span> : null}
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <a href={href} className={`${styles.card} ${styles.link}`}>
        {frame}
        <span className={styles.meta}>{meta}</span>
      </a>
    );
  }

  return (
    <figure className={styles.card}>
      {frame}
      <figcaption className={styles.meta}>{meta}</figcaption>
    </figure>
  );
}
