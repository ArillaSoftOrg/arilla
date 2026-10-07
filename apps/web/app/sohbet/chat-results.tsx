import {
  CHAT_RESULT_LIMIT,
  IntentSearchTimeoutError,
  intentSearchText,
  type SearchIntent,
  searchByIntent,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ProductCard, VisuallyHidden } from "@arilla/ui";
import { offerCountLabel, resultCountLabel } from "../ara/search-results.tsx";
import { CHAT_COPY, relaxationLabel } from "./chat-copy.ts";
import { ResultFeedback } from "./chat-feedback-client.tsx";
import { araSortParam, type ChatSortKey, sortModeFor } from "./chat-sort.ts";
import { ResultTabs } from "./chat-tabs.tsx";
import styles from "./sohbet.module.css";

interface GridItem {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  priceFromVariants?: boolean;
  offerCount: number;
  brandName: string | null;
}

/** Konuşma içi ürün kartları: `/ara` ile aynı `ProductCard`, konteynere göre akan ızgara. */
export function ChatResultGrid({
  items,
  labelledBy,
}: {
  items: readonly GridItem[];
  labelledBy: string;
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür.
    <ul className={styles.resultGrid} role="list" aria-labelledby={labelledBy}>
      {items.map((item, index) => (
        <li key={item.productId} className={styles.resultItem}>
          <ProductCard
            href={`/urun/${item.slug}`}
            title={item.title}
            brand={item.brandName}
            imageUrl={item.primaryImageUrl}
            imageLoading={index < 4 ? "eager" : "lazy"}
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

/** Tüm sonuçlar `/ara`da: niyetin metinsel hâli + fiyat kalıbı + sıralama (mevcut ayrıştırıcının anladığı biçim). */
export function fullResultsHref(intent: SearchIntent, sort: ChatSortKey = "secilen"): string {
  let text = intentSearchText(intent);
  if (intent.priceMin !== null && intent.priceMax !== null) {
    text += ` ${intent.priceMin}-${intent.priceMax} arası`;
  } else if (intent.priceMax !== null) {
    text += ` ${intent.priceMax} tl altı`;
  }
  const params = new URLSearchParams({ q: text });
  const araSort = araSortParam(sort);
  if (araSort) params.set("sort", araSort);
  return `/ara?${params.toString()}`;
}

/**
 * Bir arama mesajının ürünleri. Ürünler yalnızca mevcut arama katmanından gelir
 * (`searchByIntent` -> `searchWithFallback`); model çıktısından kart üretilmez.
 * Sonuçlar mesaja kopyalanmadığı için fiyat/stok her gösterimde günceldir. Sekme
 * değişimi model çağırmaz: aynı niyet, yalnızca `sort` farklı.
 * Hata sohbeti bozmaz: yalnızca bu blok kısa bir mesaja döner.
 */
export async function ChatResults({
  intent,
  headingId,
  retryHref,
  conversationId,
  messageSeq,
  sort,
  helpful,
}: {
  intent: SearchIntent;
  headingId: string;
  /** Arama başarısız olursa (zaman aşımı) aynı sohbeti yeniden yükleyen bağlantı; niyet saklıdır. */
  retryHref: string;
  conversationId: string;
  messageSeq: number;
  sort: ChatSortKey;
  helpful: boolean | null;
}) {
  let result: Awaited<ReturnType<typeof searchByIntent>>;
  try {
    result = await searchByIntent(getDatabase(), intent, {
      pageSize: CHAT_RESULT_LIMIT,
      sort: sortModeFor(sort),
    });
  } catch (error) {
    // Yalnızca sınıf adı: hata mesajı arama metnini taşıyabilir.
    console.error("[sohbet] search failed", error instanceof Error ? error.name : "unknown");
    const timedOut = error instanceof IntentSearchTimeoutError;
    return (
      <div className={styles.results} data-search-mode="failed" role="alert">
        <p className={styles.resultsNote}>
          {timedOut ? CHAT_COPY.searchTimedOut : CHAT_COPY.resultsUnavailable}
        </p>
        <a className={styles.seeAll} href={retryHref}>
          {CHAT_COPY.retryLabel}
        </a>
      </div>
    );
  }
  const { outcome, droppedForPrice, notes, relaxed } = result;
  const relaxationLines = [
    ...new Set(relaxed.map((r) => relaxationLabel(r)).filter((l): l is string => l !== null)),
    ...notes.map((n) => CHAT_COPY.brandExcludeUnresolved(n.value)),
  ];
  const noteBlock =
    relaxationLines.length > 0 ? (
      <ul className={styles.relaxed} aria-label={CHAT_COPY.relaxedLabel}>
        {relaxationLines.map((line) => (
          <li key={line} className={styles.relaxedItem}>
            {line}
          </li>
        ))}
      </ul>
    ) : null;

  if (outcome.mode === "empty" || outcome.items.length === 0) {
    // Seçtiklerimiz dışındaki bir sekme boşsa (örn. fırsat sıralaması fiyat istatistiği ister)
    // sekmeler kalır ve neden söylenir; sonuç "yok" denmez.
    const otherTab = sort !== "secilen";
    return (
      <section className={styles.results} data-search-mode="empty" aria-labelledby={headingId}>
        {otherTab ? (
          <ResultTabs conversationId={conversationId} active={sort} countLabel={null} />
        ) : null}
        <h3 id={headingId} className={styles.resultsHeading}>
          {otherTab ? CHAT_COPY.noResultsInTab : CHAT_COPY.noResultsTitle}
        </h3>
        <p className={styles.resultsNote}>
          {otherTab ? CHAT_COPY.noResultsInTabHint : CHAT_COPY.noResultsDescription}
        </p>
        {noteBlock}
      </section>
    );
  }

  const isFallback = outcome.mode === "fallback";
  // Kart fiyatı filtre fiyatından ayrıştıysa elenen kartlar sayıyı bozar: sayı gizlenir.
  const countKnown = !isFallback && droppedForPrice === 0;
  const total = countKnown ? outcome.total : outcome.items.length;
  return (
    <section className={styles.results} data-search-mode={outcome.mode} aria-labelledby={headingId}>
      <VisuallyHidden as="h3" id={headingId}>
        {isFallback ? CHAT_COPY.closeMatchesHeading : CHAT_COPY.resultsRegion}
      </VisuallyHidden>
      {isFallback ? (
        <p className={styles.resultsHeading}>{CHAT_COPY.closeMatchesHeading}</p>
      ) : (
        <ResultTabs
          conversationId={conversationId}
          active={sort}
          countLabel={countKnown ? resultCountLabel(total) : null}
        />
      )}
      {noteBlock}
      <ChatResultGrid items={outcome.items} labelledBy={headingId} />
      <ResultFeedback conversationId={conversationId} messageSeq={messageSeq} initial={helpful} />
      {isFallback ? null : (
        <a className={styles.seeAll} href={fullResultsHref(intent, sort)}>
          {countKnown ? CHAT_COPY.seeAllCount(total) : CHAT_COPY.seeAll}
        </a>
      )}
    </section>
  );
}
