import {
  CHAT_RESULT_LIMIT,
  intentSearchText,
  type SearchIntent,
  searchByIntent,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ProductCard } from "@arilla/ui";
import { offerCountLabel, resultCountLabel } from "../ara/search-results.tsx";
import { CHAT_COPY } from "./chat-copy.ts";
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

/** Tüm sonuçlar `/ara`da: niyetin metinsel hâli + fiyat kalıbı (mevcut ayrıştırıcının anladığı biçim). */
export function fullResultsHref(intent: SearchIntent): string {
  let text = intentSearchText(intent);
  if (intent.priceMin !== null && intent.priceMax !== null) {
    text += ` ${intent.priceMin}-${intent.priceMax} arası`;
  } else if (intent.priceMax !== null) {
    text += ` ${intent.priceMax} tl altı`;
  }
  return `/ara?${new URLSearchParams({ q: text }).toString()}`;
}

/**
 * Bir arama mesajının ürünleri. Ürünler yalnızca mevcut arama katmanından gelir
 * (`searchByIntent` -> `searchWithFallback`); model çıktısından kart üretilmez.
 * Sonuçlar mesaja kopyalanmadığı için fiyat/stok her gösterimde günceldir.
 * Hata sohbeti bozmaz: yalnızca bu blok kısa bir mesaja döner.
 */
export async function ChatResults({
  intent,
  headingId,
}: {
  intent: SearchIntent;
  headingId: string;
}) {
  let outcome: Awaited<ReturnType<typeof searchByIntent>>;
  try {
    outcome = await searchByIntent(getDatabase(), intent, { pageSize: CHAT_RESULT_LIMIT });
  } catch (error) {
    // Yalnızca sınıf adı: hata mesajı arama metnini taşıyabilir.
    console.error("[sohbet] search failed", error instanceof Error ? error.name : "unknown");
    return (
      <p className={styles.resultsNote} role="alert">
        {CHAT_COPY.resultsUnavailable}
      </p>
    );
  }

  if (outcome.mode === "empty") {
    return (
      <section className={styles.results} data-search-mode="empty" aria-labelledby={headingId}>
        <h3 id={headingId} className={styles.resultsHeading}>
          {CHAT_COPY.noResultsTitle}
        </h3>
        <p className={styles.resultsNote}>{CHAT_COPY.noResultsDescription}</p>
      </section>
    );
  }

  const isFallback = outcome.mode === "fallback";
  const total = isFallback ? outcome.items.length : outcome.total;
  return (
    <section className={styles.results} data-search-mode={outcome.mode} aria-labelledby={headingId}>
      <div className={styles.resultsHead}>
        <h3 id={headingId} className={styles.resultsHeading}>
          {isFallback ? CHAT_COPY.closeMatchesHeading : CHAT_COPY.resultsHeading}
        </h3>
        {isFallback ? null : (
          <p className={styles.resultsCount} role="status">
            {resultCountLabel(total)}
          </p>
        )}
      </div>
      <ChatResultGrid items={outcome.items} labelledBy={headingId} />
      {!isFallback && total > outcome.items.length ? (
        <a className={styles.seeAll} href={fullResultsHref(intent)}>
          {CHAT_COPY.seeAll} ({total.toLocaleString("tr-TR")})
        </a>
      ) : null}
    </section>
  );
}
