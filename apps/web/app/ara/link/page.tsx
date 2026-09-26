import {
  checkLinkSearchUrl,
  findKnownOfferByUrl,
  findLinkSearchResults,
  getLinkSearchState,
  type LinkSource,
  linkSearchHref,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, formatTRY, ProductImage, SearchForm } from "@arilla/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HOME_COPY } from "../../home-copy.ts";
import { PhotoSearchButton } from "../../photo-search-client.tsx";
import styles from "../ara.module.css";
import { ResultGrid, resultCountLabel } from "../search-results.tsx";
import linkStyles from "./link-search.module.css";
import { LINK_SEARCH_COPY, linkFailureCopy } from "./link-search-copy.ts";
import { LinkSearchWaitClient } from "./link-search-wait-client.tsx";

export const metadata: Metadata = {
  title: "Bağlantıyla ara",
  // Kullanıcının yapıştırdığı adrese bağlı, sonsuz sayıda sayfa: indekslenmez.
  robots: { index: false, follow: false },
};

function NewSearch() {
  return (
    <section className={styles.section} aria-labelledby="yeni-arama">
      <h2 id="yeni-arama" className={styles.sectionTitle}>
        {LINK_SEARCH_COPY.newSearchTitle}
      </h2>
      <div className={styles.toolbar}>
        <div className={styles.toolbarSearch}>
          <SearchForm
            placeholder={LINK_SEARCH_COPY.searchPlaceholder}
            submitLabel={LINK_SEARCH_COPY.searchSubmit}
          />
        </div>
        <PhotoSearchButton />
      </div>
    </section>
  );
}

/** Fiyat yalnızca yapılandırılmış veriden, para birimiyle birlikte geldiyse. */
function formatSourcePrice(source: LinkSource): string | null {
  if (source.price === null || source.currency === null) return null;
  if (source.currency === "TRY") return formatTRY(source.price);
  const whole = (source.price / 100).toLocaleString("tr-TR", {
    minimumFractionDigits: source.price % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${whole} ${source.currency}`;
}

/**
 * Kaynak kartı: bağlam, katalog ürünü DEĞİL. Dış bağlantı yalnızca katalogda
 * bir `offer` varsa `/git/` üzerinden verilir (CLAUDE.md kural 8: attribution
 * kaydı olmadan merchant linki yok); yoksa bağlantı hiç gösterilmez - kullanıcı
 * adresi zaten biliyor.
 */
function SourceCard({ source, offerId }: { source: LinkSource; offerId: number | null }) {
  const price = formatSourcePrice(source);
  return (
    <aside className={linkStyles.source} aria-labelledby="kaynak-urun">
      {source.imageUrl ? (
        <div className={linkStyles.sourceImage}>
          <ProductImage
            src={source.imageUrl}
            alt={source.title ?? source.site}
            aspectRatio={1}
            fit="contain"
            loading="eager"
          />
        </div>
      ) : null}
      <div className={linkStyles.sourceBody}>
        <p className={linkStyles.sourceLabel} id="kaynak-urun">
          {LINK_SEARCH_COPY.sourceLabel} · <span className={linkStyles.site}>{source.site}</span>
        </p>
        {source.title ? <p className={linkStyles.sourceTitle}>{source.title}</p> : null}
        {source.brand ? <p className={linkStyles.sourceMeta}>{source.brand}</p> : null}
        {price ? <p className={linkStyles.sourcePrice}>{price}</p> : null}
        <p className={linkStyles.sourceNote}>{LINK_SEARCH_COPY.sourceNote}</p>
        {offerId !== null ? (
          <a
            className={linkStyles.sourceLink}
            href={`/git/${offerId}?surface=search`}
            rel="nofollow noopener"
          >
            {LINK_SEARCH_COPY.sourceOpen}
          </a>
        ) : null}
        {offerId !== null ? (
          <p className={linkStyles.sourceNote}>{HOME_COPY.affiliateNotice}</p>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * docs/decisions/0031 — link araması. Üç giriş (arama kutusuna yapıştırma,
 * `/https://...` öneki, doğrudan adres) buraya yakınsar. Adres kanonik
 * (izleme parametresiz) değilse önce kanonik adrese yönlendirilir: aynı ürün
 * için tek, paylaşılabilir bir sonuç sayfası.
 */
export default async function LinkAramaPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string | string[] }>;
}) {
  const { url: urlParam } = await searchParams;
  const raw = Array.isArray(urlParam) ? urlParam[0] : urlParam;
  if (!raw?.trim()) redirect("/ara");

  const checked = checkLinkSearchUrl(raw);
  if (!checked.ok) {
    const copy = linkFailureCopy(
      checked.reason === "blocked" ? "blocked_destination" : "invalid_url",
    );
    return (
      <div className={styles.page}>
        <EmptyState
          className={styles.emptyPanel}
          title={copy.title}
          description={copy.description}
          headingLevel={1}
        />
        <NewSearch />
      </div>
    );
  }

  const { normalized } = checked;
  if (raw !== normalized.url) redirect(linkSearchHref(normalized.url));

  const db = getDatabase();
  let known: Awaited<ReturnType<typeof findKnownOfferByUrl>>;
  let state: Awaited<ReturnType<typeof getLinkSearchState>>;

  try {
    // Katalogda bu adresle eşleşmiş bir ürün varsa: aynı ürün, kanıt adresin
    // kendisi. Ürün sayfası mağaza karşılaştırmasını ve alternatifleri gösterir.
    known = await findKnownOfferByUrl(db, normalized.url);
    state = await getLinkSearchState(db, normalized.url);
  } catch (error) {
    const code =
      error instanceof Error
        ? `${error.name}${"code" in error ? `:${String(error.code)}` : ""}`
        : "unknown";
    console.warn(`[link-arama] durum sorgusu basarisiz, bos durum gosteriliyor (${code})`);
    const copy = linkFailureCopy("queue_unavailable");
    return (
      <div className={styles.page}>
        <EmptyState
          className={styles.emptyPanel}
          title={copy.title}
          description={copy.description}
          headingLevel={1}
        />
        <NewSearch />
      </div>
    );
  }
  if (known) redirect(`/urun/${known.productSlug}`);

  if (state.kind === "failed") {
    const copy = linkFailureCopy(state.errorCode);
    return (
      <div className={styles.page}>
        <EmptyState
          className={styles.emptyPanel}
          title={copy.title}
          description={copy.description}
          headingLevel={1}
        />
        <NewSearch />
      </div>
    );
  }

  if (state.kind !== "resolved") {
    return (
      <div className={styles.page}>
        <LinkSearchWaitClient url={normalized.url} site={normalized.domain} />
        <NewSearch />
      </div>
    );
  }

  const results = await findLinkSearchResults(db, state);
  const total = results.same.length + results.similar.length;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{LINK_SEARCH_COPY.resultsTitle}</h1>
        {total > 0 ? (
          <p className={styles.count} role="status">
            {resultCountLabel(total)}
          </p>
        ) : null}
      </header>

      <SourceCard source={state.source} offerId={state.offerId} />

      {results.same.length > 0 ? (
        <section className={styles.section} aria-labelledby="ayni-urun">
          <h2 id="ayni-urun" className={styles.sectionTitle}>
            {LINK_SEARCH_COPY.sameTitle}
          </h2>
          <p className={styles.lede}>
            {LINK_SEARCH_COPY.sameEvidence[results.same[0]?.evidence ?? "gtin"]}
          </p>
          <ResultGrid items={results.same} labelledBy="ayni-urun" />
        </section>
      ) : null}

      {results.similar.length > 0 ? (
        <section className={styles.section} aria-labelledby="benzer-urunler">
          <h2 id="benzer-urunler" className={styles.sectionTitle}>
            {LINK_SEARCH_COPY.similarTitle}
          </h2>
          <p className={linkStyles.signals}>
            {results.signals.image ? LINK_SEARCH_COPY.signalsImage : LINK_SEARCH_COPY.signalsText}
          </p>
          <ResultGrid items={results.similar} labelledBy="benzer-urunler" />
        </section>
      ) : null}

      {total === 0 ? (
        <EmptyState
          className={styles.emptyPanel}
          title={LINK_SEARCH_COPY.emptyTitle}
          description={LINK_SEARCH_COPY.emptyDescription}
          headingLevel={2}
        />
      ) : null}

      <NewSearch />
    </div>
  );
}
