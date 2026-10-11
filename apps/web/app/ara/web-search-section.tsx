import {
  dropCatalogDuplicates,
  signWebExit,
  type WebExitSurface,
  type WebProductGroup,
  webExitHref,
} from "@arilla/core";
import { formatTRY, ProductCard, ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import styles from "./ara.module.css";
import { WEB_SEARCH_COPY as COPY } from "./web-search-copy.ts";
import type { WebSearchBundle } from "./web-search-start.ts";

/** Internet araması sürerken: gerçek durum etiketi + iskelet kartlar. */
export function WebSearchPending() {
  return (
    <section className={styles.webSection} aria-busy="true">
      <VisuallyHidden as="p" role="status">
        {COPY.pending}
      </VisuallyHidden>
      <h2 className={styles.sectionTitle}>{COPY.heading}</h2>
      <p className={styles.webNote}>{COPY.pending}…</p>
      <div className={styles.grid} aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayıda, sırasız iskelet kartı.
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

function exitHref(
  group: WebProductGroup,
  offer: WebProductGroup["offers"][number],
  surface: WebExitSurface,
  position: number,
): string {
  return webExitHref(
    signWebExit({
      url: offer.url,
      kind: group.matchKind,
      price: offer.priceStatus === "verified" ? offer.priceKurus : null,
      priceStatus: offer.priceStatus,
      surface,
      position,
    }),
  );
}

function GroupGrid({
  groups,
  surface,
  startPosition,
  labelledBy,
}: {
  groups: readonly WebProductGroup[];
  surface: WebExitSurface;
  startPosition: number;
  labelledBy: string;
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür.
    <ul className={styles.grid} role="list" aria-labelledby={labelledBy}>
      {groups.map((group, index) => {
        const best = group.offers[0];
        if (!best) return null;
        const position = startPosition + index;
        return (
          <li key={group.key} className={styles.gridItem}>
            <ProductCard
              href={exitHref(group, best, surface, position)}
              external
              title={group.title}
              brand={group.brand}
              imageUrl={null}
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
                      href={exitHref(group, offer, surface, position)}
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
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Internet sonuçları (karar 0101). Veritabanı sonuçları bu bölümden BAĞIMSIZ
 * ve önce görünür; bu bileşen yalnızca internet araması bittiğinde akar.
 * Başarısızlıkta veritabanı sonuçlarına dokunulmaz; kapalı/uygunsuz/limitli
 * durumlarda hiçbir şey çizilmez.
 */
export async function WebSearchResults({
  promise,
  catalogTitles,
  surface,
}: {
  promise: Promise<WebSearchBundle>;
  catalogTitles: readonly string[];
  surface: WebExitSurface;
}) {
  const { outcome, catalogHosts } = await promise;
  if (outcome.status === "error" || outcome.status === "unavailable") {
    return (
      <p className={styles.webNote} role="status">
        {COPY.failed}
      </p>
    );
  }
  if (outcome.status !== "ok") return null;

  const groups = dropCatalogDuplicates(outcome.groups, {
    hosts: catalogHosts,
    titles: catalogTitles,
  });
  if (groups.length === 0) return null;

  // İmza sırrı yoksa (yapılandırma) bölüm çizilmez; veritabanı sonuçları etkilenmez.
  const probe = groups[0]?.offers[0];
  if (probe) {
    try {
      exitHref(groups[0] as WebProductGroup, probe, surface, 1);
    } catch (error) {
      console.error("[ara] web section skipped", error instanceof Error ? error.name : "unknown");
      return null;
    }
  }

  const exact = groups.filter((g) => g.matchKind === "exact");
  const similar = groups.filter((g) => g.matchKind === "similar");

  return (
    <section className={styles.webSection} aria-labelledby="internet-secenekleri">
      <h2 id="internet-secenekleri" className={styles.sectionTitle}>
        {COPY.heading}
      </h2>
      <p className={styles.webNote}>{COPY.note}</p>
      {exact.length > 0 ? (
        <>
          <h3 id="internet-ayni" className={styles.webSubTitle}>
            {COPY.exactHeading}
          </h3>
          <GroupGrid
            groups={exact}
            surface={surface}
            startPosition={1}
            labelledBy="internet-ayni"
          />
        </>
      ) : null}
      {similar.length > 0 ? (
        <>
          <h3 id="internet-benzer" className={styles.webSubTitle}>
            {COPY.similarHeading}
          </h3>
          <GroupGrid
            groups={similar}
            surface={surface}
            startPosition={exact.length + 1}
            labelledBy="internet-benzer"
          />
        </>
      ) : null}
    </section>
  );
}
