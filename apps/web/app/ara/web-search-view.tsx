import type { WebProductGroup } from "@arilla/core";
import { formatTRY, ProductCard, ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import chatStyles from "../sohbet/sohbet.module.css";
import styles from "./ara.module.css";
import { WEB_SEARCH_COPY as COPY } from "./web-search-copy.ts";

/**
 * İnternet sonuçlarının SADECE sunum görünümü (karar 0102, 0106). Katalog ve
 * internet ürünleri tek ızgarada, aynı kartla gösterilir: bu dosyadaki bileşenler
 * kendi ızgaralarını çizmez, çağıranın `<ul>` ızgarasının içine `<li>` olarak
 * girer.
 */

export type WebViewVariant = "ara" | "chat";

/** Izgaranın bir satırı kadar iskelet; sonuç gelince bu hücrelerin yerini alır. */
const PENDING_SKELETONS = 4;

/** İnternet araması sürerken: gerçek durum etiketi + ızgaranın sonunda iskelet kartlar. */
export function WebPendingItems({ variant = "ara" }: { variant?: WebViewVariant }) {
  const item = variant === "chat" ? chatStyles.resultItem : styles.gridItem;
  return (
    <>
      <li className={styles.gridStatus} aria-busy="true">
        <VisuallyHidden role="status">{COPY.pending}</VisuallyHidden>
      </li>
      {Array.from({ length: PENDING_SKELETONS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayıda, sırasız iskelet kartı.
        <li key={i} className={item} aria-hidden="true">
          <ProductCardSkeleton />
        </li>
      ))}
    </>
  );
}

/** Kartta gösterilen marka/mağaza satırı: tek mağazada gerçek mağaza adı da yazılır. */
function storeLine(group: WebProductGroup): string | null {
  const seller = group.offers.length === 1 ? (group.offers[0]?.seller ?? null) : null;
  const parts = [group.brand, seller].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Doğrulanmış gruplar, katalog kartlarıyla aynı `ProductCard` ile. Sıra çekirdekten
 * gelir (tam eşleşme → doğrulanmış fiyat → mağaza sayısı → düşük fiyat) ve
 * burada değiştirilmez; fiyatı bilinmeyen grup fiyat sırasında öne geçmez.
 */
export function WebResultItems({
  groups,
  variant = "ara",
}: {
  groups: readonly WebProductGroup[];
  variant?: WebViewVariant;
}) {
  const item = variant === "chat" ? chatStyles.resultItem : styles.gridItem;
  const shown = groups.filter((group) => group.offers.length > 0);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((group) => {
        const best = group.offers[0];
        if (!best) return null;
        return (
          <li key={group.key} className={item}>
            {/* Doğrudan mağaza bağlantısı: Google şartları grounding bağlantılarının
                izlenmesini, araya sayfa/yönlendirme girmesini yasaklar (karar 0102). */}
            <ProductCard
              href={best.url}
              external
              compactWithoutImage
              title={group.title}
              brand={storeLine(group)}
              imageUrl={group.imageUrl ?? null}
              minPrice={group.minVerifiedPriceKurus}
              priceLabel={COPY.priceUnverified}
              offerCount={group.offers.length}
              offerCountLabel={COPY.storeCount}
            />
            {group.offers.length > 1 ? (
              <details className={styles.webOffersBox}>
                <summary className={styles.webOffersToggle}>{COPY.offersToggle}</summary>
                <ul className={styles.webOffers}>
                  {group.offers.map((offer) => (
                    <li key={offer.id}>
                      <a
                        className={styles.webOffer}
                        href={offer.url}
                        target="_blank"
                        rel="nofollow noopener noreferrer sponsored"
                      >
                        <span>{offer.seller}</span>
                        <span>
                          {offer.priceKurus !== null
                            ? formatTRY(offer.priceKurus)
                            : COPY.priceUnverified}
                          {offer.inStock === false ? ` · ${COPY.outOfStock}` : ""}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        );
      })}
      <li className={styles.gridNote}>{COPY.footnote}</li>
    </>
  );
}
