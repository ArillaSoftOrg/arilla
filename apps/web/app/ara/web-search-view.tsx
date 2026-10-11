import type { WebProductGroup } from "@arilla/core";
import { formatTRY, ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import chatStyles from "../sohbet/sohbet.module.css";
import styles from "./ara.module.css";
import { WebGridItem } from "./web-grid-item.tsx";
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

/**
 * Google Search Suggestions (Gemini API "Grounding with Google Search" şartları):
 * grounding sonuçları yalnızca bununla BİRLİKTE ve DEĞİŞTİRİLMEDEN gösterilir
 * (Google'ın verdiği `renderedContent` HTML'i). Sayfamıza karışmaması için betiksiz,
 * ağ erişimi kısıtlı `sandbox` iframe içinde çizilir (yalnızca bağlantı açma izni,
 * `base target=_blank`). Biçimi, bağlantıları ve metni olduğu gibi kalır; ızgaranın
 * sonunda tek, sade bir satırdır.
 */
export function SearchSuggestionsFrame({ html }: { html: string }) {
  const doc = [
    "<!doctype html><html><head><meta charset='utf-8'>",
    "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:\">",
    "<base target='_blank'><meta name='color-scheme' content='light dark'>",
    "<style>html,body{margin:0;background:transparent}</style></head><body>",
    html,
    "</body></html>",
  ].join("");
  return (
    <iframe
      className={styles.suggestions}
      title={COPY.suggestionsTitle}
      srcDoc={doc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      loading="lazy"
    />
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
  suggestionsHtml,
  variant = "ara",
}: {
  groups: readonly WebProductGroup[];
  /** Google Search Suggestions parçası; sonuçlar yalnızca bununla birlikte çizilir. */
  suggestionsHtml: string | null;
  variant?: WebViewVariant;
}) {
  const item = variant === "chat" ? chatStyles.resultItem : styles.gridItem;
  const shown = groups.filter((group) => group.offers.length > 0);
  if (shown.length === 0 || suggestionsHtml === null) return null;
  return (
    <>
      {shown.map((group) => {
        const best = group.offers[0];
        if (!best) return null;
        return (
          <WebGridItem
            key={group.key}
            className={item}
            href={best.url}
            title={group.title}
            brand={storeLine(group)}
            imageUrl={group.imageUrl ?? null}
            minPrice={group.minVerifiedPriceKurus}
            offerCount={group.offers.length}
          >
            {/* Doğrudan mağaza bağlantısı: Google şartları grounding bağlantılarının
                izlenmesini, araya sayfa/yönlendirme girmesini yasaklar (karar 0102). */}
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
          </WebGridItem>
        );
      })}
      <li className={styles.gridNote}>{COPY.footnote}</li>
      <li className={styles.gridNote}>
        <SearchSuggestionsFrame html={suggestionsHtml} />
      </li>
    </>
  );
}
