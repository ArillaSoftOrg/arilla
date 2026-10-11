import type { WebProductGroup } from "@arilla/core";
import { formatTRY, ProductCard, ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import chatStyles from "../sohbet/sohbet.module.css";
import styles from "./ara.module.css";
import { WebGridItem } from "./web-grid-item.tsx";
import { WEB_SEARCH_COPY as COPY } from "./web-search-copy.ts";

/**
 * İnternet sonuçlarının ortak, SADECE sunum görünümü (karar 0102). `/ara`,
 * `/ara/link` (sunucu) ve sohbet (istemci) aynı bileşeni kullanır; sunucu API'si
 * çağırmaz, bu yüzden istemci bileşeninden de içe aktarılabilir.
 */

export type WebViewVariant = "ara" | "chat";

/** Internet araması sürerken: gerçek durum etiketi + iskelet kartlar. */
export function WebSearchPending({ variant = "ara" }: { variant?: WebViewVariant }) {
  const grid = variant === "chat" ? chatStyles.resultGrid : styles.grid;
  return (
    <section className={styles.webSection} aria-busy="true">
      <VisuallyHidden as="p" role="status">
        {COPY.pending}
      </VisuallyHidden>
      <h2 className={styles.sectionTitle}>{COPY.heading}</h2>
      <p className={styles.webNote}>{COPY.pending}…</p>
      <div className={grid} aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayıda, sırasız iskelet kartı.
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

/**
 * Google Search Suggestions (Gemini API "Grounding with Google Search" şartları):
 * grounding sonuçları yalnızca bununla BİRLİKTE ve DEĞİŞTİRİLMEDEN gösterilir.
 * Parça Google'dan gelen HTML'dir; sayfamıza karışmaması için betiksiz, ağ
 * erişimi kısıtlı `sandbox` iframe içinde çizilir (yalnızca bağlantı açma izni,
 * `base target=_blank`). Biçimi, bağlantıları ve metni olduğu gibi kalır.
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

function Grid({
  groups,
  variant,
  labelledBy,
}: {
  groups: readonly WebProductGroup[];
  variant: WebViewVariant;
  labelledBy: string;
}) {
  const grid = variant === "chat" ? chatStyles.resultGrid : styles.grid;
  const item = variant === "chat" ? chatStyles.resultItem : styles.gridItem;
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür.
    <ul className={grid} role="list" aria-labelledby={labelledBy}>
      {groups.map((group) => {
        const best = group.offers[0];
        // Gorselsiz internet urunu gosterilmez (karar 0102).
        if (!best || !group.imageUrl) return null;
        return (
          <WebGridItem key={group.key} className={item} imageUrl={group.imageUrl}>
            {/* Doğrudan mağaza bağlantısı: Google şartları grounding bağlantılarının
                izlenmesini, araya sayfa/yönlendirme girmesini yasaklar (karar 0102). */}
            <ProductCard
              href={best.url}
              external
              title={group.title}
              brand={group.brand}
              imageUrl={group.imageUrl}
              minPrice={group.minVerifiedPriceKurus}
              priceLabel={COPY.priceUnverified}
              sourceLabel={COPY.sourceBadge}
              offerCount={group.offers.length}
              offerCountLabel={COPY.storeCount}
            />
            {group.offers.length > 1 ? (
              <ul className={styles.webOffers} aria-label={COPY.offersLabel}>
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
            ) : null}
          </WebGridItem>
        );
      })}
    </ul>
  );
}

/**
 * Doğrulanmış gruplar + Search Suggestions. `suggestionsHtml` yoksa HİÇBİR ŞEY
 * çizilmez (Google şartı: sonuçlar öneriler olmadan gösterilemez).
 */
export function WebResultsView({
  groups,
  suggestionsHtml,
  variant = "ara",
  idPrefix = "internet",
}: {
  groups: readonly WebProductGroup[];
  suggestionsHtml: string | null;
  variant?: WebViewVariant;
  idPrefix?: string;
}) {
  if (!groups.some((g) => g.imageUrl) || suggestionsHtml === null) return null;
  const exact = groups.filter((g) => g.matchKind === "exact");
  const similar = groups.filter((g) => g.matchKind === "similar");
  return (
    <section className={styles.webSection} aria-labelledby={`${idPrefix}-baslik`}>
      <h2 id={`${idPrefix}-baslik`} className={styles.sectionTitle}>
        {COPY.heading}
      </h2>
      <p className={styles.webNote}>{COPY.note}</p>
      {exact.length > 0 ? (
        <div className={styles.webGroup}>
          <h3 id={`${idPrefix}-ayni`} className={styles.webSubTitle}>
            {COPY.exactHeading}
          </h3>
          <Grid groups={exact} variant={variant} labelledBy={`${idPrefix}-ayni`} />
        </div>
      ) : null}
      {similar.length > 0 ? (
        <div className={styles.webGroup}>
          <h3 id={`${idPrefix}-benzer`} className={styles.webSubTitle}>
            {COPY.similarHeading}
          </h3>
          <Grid groups={similar} variant={variant} labelledBy={`${idPrefix}-benzer`} />
        </div>
      ) : null}
      <SearchSuggestionsFrame html={suggestionsHtml} />
    </section>
  );
}
