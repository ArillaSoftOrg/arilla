import { FallbackImage } from "./FallbackImage.tsx";
import { ProductImage } from "./ProductImage.tsx";
import styles from "./TrendCollectionCard.module.css";
import { TrendThumbnails } from "./TrendThumbnails.tsx";

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
  /** `null`: kapak yok - notr yer tutucu kutusu cizilir (bozuk gorsel yerine). */
  heroImageUrl: string | null;
  heroImageAlt: string;
  /**
   * Verilirse kapak bu adaylari tarayicida sirayla dener (`FallbackImage`);
   * hepsi kirikse yer tutucu cizilir. Verilmezse `heroImageUrl` tek basina kullanilir.
   */
  heroImageCandidates?: readonly string[];
  /**
   * Onizleme havuzu. `productsVisible`dan fazla verilirse kirik gorselin yerine
   * sonraki urun gelir (`TrendThumbnails`); verilmezse hepsi gosterilir.
   */
  products?: readonly TrendCollectionProduct[];
  /** Ayni anda gosterilecek onizleme sayisi (varsayilan: havuzun tamami). */
  productsVisible?: number;
  /** Verilirse TUM kart tek baglantidir (baslik baglantisi karti kaplar). */
  href?: string;
  /** Trenddeki toplam urun; onizlemeden fazlasi "+N urun" olarak yazilir. */
  productCount?: number;
  /** Hazir metin: "1.250 TL'den baslayan". Veri yoksa verilmez, uydurulmaz. */
  startingPriceLabel?: string;
  /** "+N urun" metnini uretir; metin cagirana aittir (docs/copy.md). */
  moreProductsLabel?: (extra: number) => string;
}

export type TrendCollectionCardProps = TrendCollection & {
  /** Varsayilan "lazy"; yalnizca ilk ekrandaki ilk kart "eager". */
  heroImageLoading?: "lazy" | "eager";
  /** LCP adayi olan ilk kart icin "high". */
  heroImageFetchPriority?: "high" | "low" | "auto";
};

/**
 * Editoryal trend karti (design.md "Trend kartı": kapak, baslik, urun
 * onizlemeleri). Veri kaynagini bilmez - ana sayfa demo seti ya da DB'deki
 * `trend` kayitlari (`getPublicTrends`) ayni karti kullanir.
 *
 * `href` yoksa kart baglanti DEGIL (sahte href uretilmez); varsa baslik
 * baglantisinin `::after` katmani karti kaplar: tek odak noktasi, tek
 * ekran okuyucu baglantisi, tum kart tiklanabilir. Klasik e-ticaret
 * `ProductCard`i degil: urun bilgisi yalniz kucuk onizleme + sayi + baslangic fiyati.
 */
export function TrendCollectionCard({
  eyebrow,
  title,
  description,
  heroImageUrl,
  heroImageAlt,
  heroImageCandidates,
  products,
  productsVisible,
  href,
  productCount,
  startingPriceLabel,
  moreProductsLabel,
  heroImageLoading = "lazy",
  heroImageFetchPriority,
}: TrendCollectionCardProps) {
  const shown = Math.min(products?.length ?? 0, productsVisible ?? products?.length ?? 0);
  const extra = productCount !== undefined ? Math.max(productCount - shown, 0) : 0;
  const moreText = extra > 0 && moreProductsLabel ? moreProductsLabel(extra) : "";

  return (
    <article className={styles.card}>
      <div className={styles.frame}>
        {heroImageCandidates && heroImageCandidates.length > 0 ? (
          <FallbackImage
            srcs={heroImageCandidates}
            alt={heroImageAlt}
            className={styles.heroImage}
            placeholderClassName={styles.heroPlaceholder}
            fit="contain"
            loading={heroImageLoading}
            fetchPriority={heroImageFetchPriority}
          />
        ) : heroImageUrl ? (
          <ProductImage
            src={heroImageUrl}
            alt={heroImageAlt}
            className={styles.heroImage}
            fit="contain"
            loading={heroImageLoading}
            fetchPriority={heroImageFetchPriority}
          />
        ) : (
          <div className={styles.heroPlaceholder} aria-hidden="true" />
        )}
      </div>
      <div className={styles.body}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h3 className={styles.title}>
          {href ? (
            <a href={href} className={styles.link}>
              {title}
            </a>
          ) : (
            title
          )}
        </h3>
        <p className={styles.description}>{description}</p>
        <TrendThumbnails
          products={products ?? []}
          visibleCount={productsVisible ?? products?.length ?? 0}
          moreText={moreText}
        />
        {startingPriceLabel ? <p className={styles.price}>{startingPriceLabel}</p> : null}
      </div>
    </article>
  );
}
