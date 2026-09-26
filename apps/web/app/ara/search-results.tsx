import { ProductCard, ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import styles from "./ara.module.css";

/** docs/copy.md `search.offer_count`. */
export function offerCountLabel(count: number): string {
  return `${count} mağaza`;
}

/** docs/copy.md `search.result_count` - binlik ayraçlı ("1.240 sonuç"). */
export function resultCountLabel(count: number): string {
  return `${count.toLocaleString("tr-TR")} sonuç`;
}

/**
 * `SearchResultItem` ve `VisualSearchItem`'in kartta gösterilen ortak alt
 * kümesi. `brandName` yalnızca metin aramasında var; görsel arama tipinde
 * yok, uydurulmaz.
 */
export interface ResultGridItem {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  /** 0037: kart fiyati varyantlar arasi baslangic fiyati mi. */
  priceFromVariants?: boolean;
  offerCount: number;
  brandName?: string | null;
}

/** İlk ekrandaki (mobilde ilk iki satır) görseller gecikmeden yüklenir. */
const EAGER_IMAGE_COUNT = 4;

/** docs/pages.md "/ara" sonuç ızgarası: 2/3/4/5 sütun, liste semantiği. */
export function ResultGrid({
  items,
  labelledBy,
}: {
  items: readonly ResultGridItem[];
  labelledBy?: string;
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür.
    <ul className={styles.grid} role="list" aria-labelledby={labelledBy}>
      {items.map((item, index) => (
        <li key={item.productId} className={styles.gridItem}>
          <ProductCard
            href={`/urun/${item.slug}`}
            title={item.title}
            brand={item.brandName ?? null}
            imageUrl={item.primaryImageUrl}
            imageLoading={index < EAGER_IMAGE_COUNT ? "eager" : "lazy"}
            minPrice={item.minPrice}
            priceFrom={item.priceFromVariants ?? false}
            offerCount={item.offerCount}
            offerCountLabel={offerCountLabel}
          />
        </li>
      ))}
    </ul>
  );
}

const SKELETON_COUNT = 12;

/**
 * Yalnizca sonuca bagli bolgenin iskeleti (sayi, sekmeler, izgara). Sayfa
 * kabugu, arama kutusu ve netlestirme sorusu yerinde kalir; sonuc gelince
 * yalnizca bu alan degisir. Mobilde ilk iki satir kadar kart yeter.
 */
export function ResultsRegionSkeleton({ statusLabel }: { statusLabel: string }) {
  return (
    <>
      <VisuallyHidden as="p" role="status">
        {statusLabel}
      </VisuallyHidden>
      <div className={`${styles.skeletonBar} ${styles.skeletonCount}`} aria-hidden="true" />
      <div className={styles.skeletonTabs} aria-hidden="true">
        <div className={styles.skeletonTab} />
        <div className={styles.skeletonTab} />
        <div className={styles.skeletonTab} />
      </div>
      <div className={styles.grid} aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayıda, sırasız iskelet kartı.
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </>
  );
}

/**
 * docs/pages.md: "Yükleniyor: iskelet kart, spinner değil." Kartlar
 * dekoratif; ekran okuyucuya tek bir durum cümlesi söylenir.
 */
export function ResultsSkeleton({
  statusLabel,
  showTabs = true,
}: {
  statusLabel: string;
  /** Görsel aramada sıralama sekmesi yok; yer tutucusu da çizilmez. */
  showTabs?: boolean;
}) {
  return (
    <div className={styles.page}>
      <VisuallyHidden as="p" role="status">
        {statusLabel}
      </VisuallyHidden>
      <div className={styles.header} aria-hidden="true">
        <div className={`${styles.skeletonBar} ${styles.skeletonTitle}`} />
        <div className={`${styles.skeletonBar} ${styles.skeletonCount}`} />
      </div>
      {showTabs ? (
        <div className={styles.skeletonTabs} aria-hidden="true">
          <div className={styles.skeletonTab} />
          <div className={styles.skeletonTab} />
          <div className={styles.skeletonTab} />
        </div>
      ) : null}
      <div className={styles.grid} aria-hidden="true">
        {Array.from({ length: SKELETON_COUNT }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayıda, sırasız iskelet kartı.
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
