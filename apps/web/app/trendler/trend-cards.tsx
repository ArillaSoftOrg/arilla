import type { TrendSummary } from "@arilla/core";
import { formatStartingPrice, TrendCollectionCard } from "@arilla/ui";
import { moreProductsLabel } from "./trend-copy.ts";
import styles from "./trendler.module.css";

/** `/trendler/<slug>` - tek yerden uretilir (kart, ana sayfa ve testler ayni adresi kullanir). */
export function trendHref(slug: string): string {
  return `/trendler/${slug}`;
}

/** Ilk ekrandaki (ilk satir) kapaklar gecikmeden yuklenir. */
const EAGER_COVER_COUNT = 3;

/**
 * Trend kartlari izgarasi: telefon 1, tablet 2, masaustu 3 sutun. Liste
 * semantigi, her kart tek baglanti. `eagerFirst` yalnizca sayfanin ilk
 * izgarasinda verilir (LCP adayi).
 */
export function TrendCardGrid({
  trends,
  eagerFirst = false,
  labelledBy,
}: {
  trends: readonly TrendSummary[];
  eagerFirst?: boolean;
  labelledBy?: string;
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur.
    <ul role="list" className={styles.grid} aria-labelledby={labelledBy}>
      {trends.map((trend, index) => {
        const eager = eagerFirst && index < EAGER_COVER_COUNT;
        return (
          <li key={trend.id} className={styles.gridItem}>
            <TrendCollectionCard
              id={String(trend.id)}
              title={trend.title}
              description={trend.description}
              href={trendHref(trend.slug)}
              heroImageUrl={trend.heroImageUrl}
              // Baslik baglantisi zaten adi tasir; kapak dekoratif.
              heroImageAlt=""
              heroImageLoading={eager ? "eager" : "lazy"}
              heroImageFetchPriority={eagerFirst && index === 0 ? "high" : undefined}
              products={trend.thumbnails.map((thumb) => ({
                id: String(thumb.productId),
                title: thumb.title,
                brand: thumb.brandName ?? undefined,
                imageUrl: thumb.imageUrl,
                imageAlt: "",
              }))}
              productCount={trend.productCount}
              startingPriceLabel={
                trend.startingPrice === null ? undefined : formatStartingPrice(trend.startingPrice)
              }
              moreProductsLabel={moreProductsLabel}
            />
          </li>
        );
      })}
    </ul>
  );
}
