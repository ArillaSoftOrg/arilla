import {
  buildResultCommentary,
  CHAT_RESULT_LIMIT,
  createChatTimer,
  type ForeignPrice,
  findAlternatives,
  IntentSearchTimeoutError,
  intentSearchText,
  isAliExpressImageVariantsEnabled,
  logChatTimings,
  type SearchIntent,
  searchByIntent,
  summarizeResults,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ProductCard, VisuallyHidden } from "@arilla/ui";
import { type ReactNode, Suspense } from "react";
import { cardPriceProps, resultCountLabel } from "../lib/search/search-results.tsx";
import { WebGridItems, WebOnlyResults } from "../lib/search/web-search-section.tsx";
import { startWebSearch } from "../lib/search/web-search-start.ts";
import { CHAT_COPY, relaxationLabel } from "./chat-copy.ts";
import { ExplainChip } from "./chat-explain-chip.tsx";
import { ExplanationFeedback } from "./chat-explanation-feedback.tsx";
import { ResultFeedback } from "./chat-feedback-client.tsx";
import {
  ALTERNATIVES_MAX,
  ALTERNATIVES_MIN,
  COMMENTARY_HEAD_COUNT,
  OLDER_BLOCK_RESULT_LIMIT,
  REVEAL_INITIAL_COUNT,
  webCardLimit,
} from "./chat-open.ts";
import { ChatCardActions } from "./chat-product-cards.tsx";
import { chatToolProduct } from "./chat-product-display.ts";
import { ChatResultReveal } from "./chat-reveal.tsx";
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
  /** Karar 0129: bkz. `cardPriceProps`. */
  foreignPrice?: ForeignPrice /** Karar 0131: kaynak magaza; bkz. `cardPriceProps`. */;
  merchantName?: string | null;
}

/**
 * Sohbet kart görselinin ekrandaki genişliği (karar 0166; `sohbet.module.css`
 * `.chat` max 68rem + `.resultGrid` 2/3 sütun @720). Ölçüm: 390->147, 720->185,
 * 1024->281, 1280+->323 px. Izgara değişirse güncellenir.
 */
const CHAT_GRID_IMAGE_SIZES =
  "(min-width: 1152px) 323px, (min-width: 1024px) calc((100vw - 182px) / 3), (min-width: 720px) calc((100vw - 166px) / 3), calc(50vw - 48px)";

/**
 * Kart fiyatı (`cardPriceProps`). Karar 0202 (`CHAT_UX_V2`): fiyatı olmayan ürünün kartında "—"
 * yerine "Fiyat bilgisi yok" yazar (fiyat uydurulmaz).
 */
function priceProps(item: GridItem, uxV2: boolean) {
  const props = cardPriceProps(item);
  if (uxV2 && props.minPrice === null && !props.priceLabel) {
    return { ...props, priceLabel: CHAT_COPY.priceMissing };
  }
  return props;
}

/** Konuşma içi ürün kartları: arama turuyla aynı `ProductCard`, konteynere göre akan ızgara. */
export function ChatResultGrid({
  items,
  labelledBy,
  extra,
  reveal = false,
  commentary = null,
}: {
  items: readonly GridItem[];
  labelledBy: string;
  /** Karar 0201: ilk kartlardan sonra gösterilen değerlendirme bölümü (yalnız `reveal` iken). */
  commentary?: ReactNode;
  /** Aynı ızgaranın sonuna eklenen `<li>`ler (karar 0106: internet kartları). */
  extra?: ReactNode;
  /** Karar 0200 (`CHAT_UX_V2`): ilk kartlar görünür, devamı "Tüm N sonucu gör" ile açılır. */
  reveal?: boolean;
}) {
  // Karar 0167: bayrak istek başına sunucuda okunur (varsayılan kapalı).
  const aliexpressVariants = isAliExpressImageVariantsEnabled();
  const cards = items.map((item, index) => (
    <li key={item.productId} className={styles.resultItem}>
      <ProductCard
        href={`/urun/${item.slug}`}
        title={item.title}
        brand={item.brandName}
        imageUrl={item.primaryImageUrl}
        imageLoading={index < 4 ? "eager" : "lazy"}
        imageSizes={CHAT_GRID_IMAGE_SIZES}
        aliexpressVariants={aliexpressVariants}
        action={<ChatCardActions product={chatToolProduct(item)} />}
        {...priceProps(item, reveal)}
      />
    </li>
  ));
  if (reveal) {
    // Karar 0200/0201: ilk 4 kart, hemen altında olgusal değerlendirme, devamı kademeli.
    const head = cards.slice(0, COMMENTARY_HEAD_COUNT);
    const rest = cards.slice(COMMENTARY_HEAD_COUNT);
    return (
      <>
        {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür. */}
        <ul className={styles.resultGrid} role="list" aria-labelledby={labelledBy}>
          {head}
          {rest.length === 0 ? extra : null}
        </ul>
        {commentary}
        {rest.length > 0 ? (
          <ChatResultReveal
            labelledBy={labelledBy}
            extra={extra}
            initialCount={REVEAL_INITIAL_COUNT - COMMENTARY_HEAD_COUNT}
            totalCount={items.length}
          >
            {rest}
          </ChatResultReveal>
        ) : null}
      </>
    );
  }
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür.
    <ul className={styles.resultGrid} role="list" aria-labelledby={labelledBy}>
      {cards}
      {extra}
    </ul>
  );
}

/** Karar 0201: modelsiz, doğrulanmış verilerden hesaplanan kısa değerlendirme; yoksa hiçbir şey. */
function CommentarySection({
  items,
  seed,
  conversationId,
  messageSeq,
  explanationHelpful,
  answerEnabled,
}: {
  items: readonly GridItem[];
  seed: string;
  /** Karar 0203: kullanıcı sonuç cevabı pilotunda; "Farkları açıkla" çipi gösterilir. */
  answerEnabled: boolean;
  conversationId: string;
  messageSeq: number;
  /** Karar 0202: değerlendirmeye verilmiş ayrı oy; yoksa `null`. */
  explanationHelpful: boolean | null;
}) {
  const commentary = buildResultCommentary(items, { seed });
  if (!commentary) return null;
  return (
    <>
      <section className={styles.commentary} aria-label={CHAT_COPY.commentaryLabel}>
        <p>{commentary.sentences.join(" ")}</p>
      </section>
      {answerEnabled ? <ExplainChip /> : null}
      <ExplanationFeedback
        conversationId={conversationId}
        messageSeq={messageSeq}
        initial={explanationHelpful}
      />
    </>
  );
}

/**
 * "Benzer seçenekler" şeridi (karar 0202): ilk sonucun `similarity_edge` komşuları, sayfadaki
 * ürünlerle çakışanlar çıkarılır; en az 3 gerçek alternatif yoksa HİÇBİR ŞEY çizilmez. Yatay
 * kaydırılır, ana sonuçlarla karışmaz. Hata/boş: sessizce yok (sonuçlar etkilenmez).
 */
async function AlternativesStrip({
  anchorProductId,
  shownIds,
}: {
  anchorProductId: number;
  shownIds: ReadonlySet<number>;
}) {
  let found: Awaited<ReturnType<typeof findAlternatives>> = [];
  try {
    found = await findAlternatives(getDatabase(), anchorProductId, { limit: 12 });
  } catch {
    return null;
  }
  const items = found.filter((item) => !shownIds.has(item.productId)).slice(0, ALTERNATIVES_MAX);
  if (items.length < ALTERNATIVES_MIN) return null;
  const aliexpressVariants = isAliExpressImageVariantsEnabled();
  return (
    <section className={styles.altSection} aria-label={CHAT_COPY.alternativesLabel}>
      <h4 className={styles.altHeading}>{CHAT_COPY.alternativesLabel}</h4>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür. */}
      <ul className={styles.altStrip} role="list">
        {items.map((item) => (
          <li key={item.productId} className={styles.altItem}>
            <ProductCard
              href={`/urun/${item.slug}`}
              title={item.title}
              brand={item.brandName}
              imageUrl={item.primaryImageUrl}
              imageLoading="lazy"
              imageSizes="152px"
              aliexpressVariants={aliexpressVariants}
              {...cardPriceProps(item)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Sonuç özeti (karar 0200): "12 mağazadan 20 ürün"; sayılar gösterilen katalog kartlarından. */
function SummaryLine({ items }: { items: readonly GridItem[] }) {
  const { storeCount, productCount } = summarizeResults(items);
  return (
    <p className={styles.summary} role="status" aria-label={CHAT_COPY.summaryLabel}>
      <svg
        className={styles.summaryIcon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <span>{CHAT_COPY.summary(storeCount, productCount)}</span>
    </p>
  );
}

/** Tüm sonuçlar arama turunda (`/sohbet?q=`, karar 0176): niyetin metinsel hâli + fiyat kalıbı + sıralama (mevcut ayrıştırıcının anladığı biçim). */
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
  return `/sohbet?${params.toString()}`;
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
  explanationHelpful = null,
  answerEnabled = false,
  uxV2 = false,
  compact = false,
}: {
  intent: SearchIntent;
  headingId: string;
  /** Arama başarısız olursa (zaman aşımı) aynı sohbeti yeniden yükleyen bağlantı; niyet saklıdır. */
  retryHref: string;
  conversationId: string;
  messageSeq: number;
  sort: ChatSortKey;
  helpful: boolean | null;
  /** Karar 0202: değerlendirme metnine verilen ayrı oy. */
  explanationHelpful?: boolean | null;
  /** Karar 0203: sonuç cevabı pilotundaki kullanıcı. */
  answerEnabled?: boolean;
  /** Karar 0200 (`CHAT_UX_V2`): özet satırı + kademeli gösterim; kapalıyken bugünkü düzen. */
  uxV2?: boolean;
  /** Karar 0200: kullanıcının açtığı ESKİ blok: az kart, sekme/internet/oy yok. */
  compact?: boolean;
}) {
  // Karar 0102: internet araması katalog aramasıyla paralel başlar. Sorgu, modelin
  // çıkardığı niyetin metinsel hâlidir (görsel eki de buna iner; görselin kendisi
  // gitmez). Yalnızca varsayılan sekmede; sekme değişimi yeniden aramaz. Açılan eski blokta
  // internet araması yoktur (ek model çağrısı/maliyet).
  const webSearch =
    sort === "secilen" && !compact
      ? startWebSearch({ kind: "text", text: intentSearchText(intent) })
      : null;
  let result: Awaited<ReturnType<typeof searchByIntent>>;
  const timer = createChatTimer();
  try {
    result = await timer.time("search", () =>
      searchByIntent(getDatabase(), intent, {
        pageSize: compact ? OLDER_BLOCK_RESULT_LIMIT : CHAT_RESULT_LIMIT,
        sort: sortModeFor(sort, uxV2),
        // Karar 0178: gölge olcum yalniz varsayilan sekmede (sekme degisimi ikinci kez olcmez).
        semanticShadow: sort === "secilen",
      }),
    );
    // Yalnizca sure (metin/sorgu yok); `CHAT_TIMING_LOG=true` ile yazilir.
    logChatTimings("search", "ok", timer.finish());
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
    const emptyBlock = (
      <>
        <h3 id={headingId} className={styles.resultsHeading}>
          {otherTab ? CHAT_COPY.noResultsInTab : CHAT_COPY.noResultsTitle}
        </h3>
        <p className={styles.resultsNote}>
          {otherTab ? CHAT_COPY.noResultsInTabHint : CHAT_COPY.noResultsDescription}
        </p>
        {noteBlock}
      </>
    );
    // Karar 0106: katalog boşken internet aramasının sonucu beklenir; "ürün yok" yalnızca
    // bütün uygun kaynaklar tamamlandıktan sonra söylenir. Arama başarısızsa bu ayrıca belirtilir.
    const waitForWeb = webSearch !== null && !otherTab;
    return (
      <section
        className={styles.results}
        data-search-mode="empty"
        {...(waitForWeb
          ? { "aria-label": CHAT_COPY.resultsRegion }
          : { "aria-labelledby": headingId })}
      >
        {otherTab ? (
          <ResultTabs conversationId={conversationId} active={sort} countLabel={null} uxV2={uxV2} />
        ) : null}
        {waitForWeb ? (
          <WebOnlyResults promise={webSearch} variant="chat" catalog={[]} empty={emptyBlock} />
        ) : (
          emptyBlock
        )}
      </section>
    );
  }

  const isFallback = outcome.mode === "fallback";
  // Kart fiyatı filtre fiyatından ayrıştıysa elenen kartlar sayıyı bozar: sayı gizlenir.
  const countKnown = !isFallback && droppedForPrice === 0;
  return (
    <section className={styles.results} data-search-mode={outcome.mode} aria-labelledby={headingId}>
      <VisuallyHidden as="h3" id={headingId}>
        {isFallback ? CHAT_COPY.closeMatchesHeading : CHAT_COPY.resultsRegion}
      </VisuallyHidden>
      {isFallback ? (
        <p className={styles.resultsHeading}>{CHAT_COPY.closeMatchesHeading}</p>
      ) : (
        <>
          {uxV2 ? <SummaryLine items={outcome.items} /> : null}
          {compact ? null : (
            <ResultTabs
              conversationId={conversationId}
              active={sort}
              countLabel={!uxV2 && countKnown ? resultCountLabel(outcome.items.length) : null}
              uxV2={uxV2}
            />
          )}
        </>
      )}
      {noteBlock}
      <ChatResultGrid
        items={outcome.items}
        labelledBy={headingId}
        reveal={uxV2 && !compact && !isFallback}
        commentary={
          uxV2 && !compact && !isFallback ? (
            <>
              <CommentarySection
                items={outcome.items}
                seed={intent.query}
                conversationId={conversationId}
                messageSeq={messageSeq}
                explanationHelpful={explanationHelpful}
                answerEnabled={answerEnabled}
              />
              {outcome.items[0] ? (
                <Suspense fallback={null}>
                  <AlternativesStrip
                    anchorProductId={outcome.items[0].productId}
                    shownIds={new Set(outcome.items.map((item) => item.productId))}
                  />
                </Suspense>
              ) : null}
            </>
          ) : null
        }
        extra={
          webSearch && !isFallback ? (
            <WebGridItems
              promise={webSearch}
              variant="chat"
              // Karar 0200: katalog + internet kartları sekme başına en fazla 30.
              limit={uxV2 ? webCardLimit(outcome.items.length) : undefined}
              catalog={outcome.items.map((item) => ({
                title: item.title,
                imageUrl: item.primaryImageUrl,
              }))}
            />
          ) : null
        }
      />
      {compact ? null : (
        <ResultFeedback
          conversationId={conversationId}
          messageSeq={messageSeq}
          initial={helpful}
          question={uxV2 ? CHAT_COPY.resultsFeedbackQuestion : undefined}
        />
      )}
    </section>
  );
}
