import { type ForeignPrice, formatMinorWithCurrency } from "@arilla/core";
import {
  formatTRY,
  ProductCard,
  type ProductCardProps,
  ProductCardSkeleton,
  VisuallyHidden,
} from "@arilla/ui";
import type { ReactNode } from "react";
import styles from "./ara.module.css";

/** docs/copy.md `search.offer_count`. */
export function offerCountLabel(count: number): string {
  return `${count} mağaza`;
}

/** docs/copy.md `offers.approx`, `offers.source_international`, `offers.rate_note`, `offers.shipping_unknown`. */
const FOREIGN_CARD_COPY = {
  approx: (tl: string) => `≈ ${tl}`,
  source: "Yurt dışı",
  rateNote: (date: string) => `TCMB kuru, ${date}`,
  shippingUnknown: "Kargo ve vergi belirsiz",
} as const;

function trDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/**
 * Kartin fiyat/mağaza satiri. Karar 0129: secilen teklif yurt disiysa yaklasik TL
 * `minPrice`'a VERILMEZ (kesin fiyat gibi gorunmesin; `/teklifler` ile ayni desen):
 * "≈ 1.234 TL · 30,00 USD", "Yurt dışı" rozeti, kur tarihi ve kargo/vergi belirsizligi.
 */
export function cardPriceProps(item: {
  minPrice: number | null;
  priceFromVariants?: boolean;
  /** Verilmezse (alternatif seridi) TRY kartta magaza sayisi satiri cizilmez. */
  offerCount?: number;
  foreignPrice?: ForeignPrice;
}): Pick<
  ProductCardProps,
  "minPrice" | "priceFrom" | "priceLabel" | "sourceLabel" | "offerCount" | "offerCountLabel"
> {
  const foreign = item.foreignPrice;
  if (!foreign || item.minPrice === null) {
    return {
      minPrice: item.minPrice,
      priceFrom: item.priceFromVariants ?? false,
      ...(item.offerCount === undefined ? {} : { offerCount: item.offerCount, offerCountLabel }),
    };
  }
  const original = formatMinorWithCurrency(foreign.originalMinor, foreign.currency);
  const meta = `${FOREIGN_CARD_COPY.rateNote(trDate(foreign.fxDate))} · ${FOREIGN_CARD_COPY.shippingUnknown}`;
  return {
    minPrice: null,
    priceLabel: `${FOREIGN_CARD_COPY.approx(formatTRY(item.minPrice))} · ${original}`,
    sourceLabel: FOREIGN_CARD_COPY.source,
    offerCount: item.offerCount ?? 0,
    offerCountLabel: () => meta,
  };
}

/** docs/copy.md `search.result_count` - binlik ayraçlı ("1.240 sonuç"). */
/**
 * Karar 0129: `capped` iken toplam sınırlı aday kümesinin içinden sayılmıştır;
 * gerçek eşleşme daha fazladır ("1.000+ sonuç").
 */
export function resultCountLabel(count: number, capped = false): string {
  return `${count.toLocaleString("tr-TR")}${capped ? "+" : ""} sonuç`;
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
  /** Karar 0129: secilen teklif yurt disiysa; `minPrice` o zaman yaklasik TL'dir. */
  foreignPrice?: ForeignPrice;
}

/** İlk ekrandaki (mobilde ilk iki satır) görseller gecikmeden yüklenir. */
const EAGER_IMAGE_COUNT = 4;

/** docs/pages.md "/ara" sonuç ızgarası: 2/3/4/5 sütun, liste semantiği. */
export function ResultGrid({
  items,
  labelledBy,
  extra,
}: {
  items: readonly ResultGridItem[];
  labelledBy?: string;
  /** Aynı ızgaranın sonuna eklenen `<li>`ler (karar 0106: internet kartları). */
  extra?: ReactNode;
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
            {...cardPriceProps(item)}
          />
        </li>
      ))}
      {extra}
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
