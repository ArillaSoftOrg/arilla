import { type ChatMessageView, intentChips } from "@arilla/core";
import { ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import { Suspense } from "react";
import { CHAT_COPY } from "./chat-copy.ts";
import { ChatResults } from "./chat-results.tsx";
import { type ChatSortKey, parseSortKey } from "./chat-sort.ts";
import { ResultTabs } from "./chat-tabs.tsx";
import styles from "./sohbet.module.css";

/** Konuşmada ürün bloğu gösterilen en son arama sayısı; öncekiler yalnızca özet. */
export const RESULT_BLOCKS_SHOWN = 1;

function ResultsFallback({ conversationId, sort }: { conversationId: string; sort: ChatSortKey }) {
  return (
    <div className={styles.results} aria-busy="true">
      <VisuallyHidden as="p" role="status">
        {CHAT_COPY.resultsLoading}
      </VisuallyHidden>
      <ResultTabs conversationId={conversationId} active={sort} countLabel={null} />
      <div className={styles.resultGrid} aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayıda, sırasız iskelet kartı.
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Sunucuda çizilen konuşma geçmişi: kullanıcı sağda, asistan solda, arama
 * mesajlarının altında anlaşılan niyet ve gerçek ürün sonuçları. Etkileşimli
 * parçalar (soru kartı, giriş kutusu) `ChatInteractive`tedir.
 */
export function ChatThread({
  messages,
  conversationId,
  sortParam,
}: {
  messages: readonly ChatMessageView[];
  conversationId: string;
  /** `?sirala=` ham değeri; geçersizse niyetin tercihi/varsayılan. */
  sortParam?: string;
}) {
  const searchSeqs = messages
    .filter((m) => m.role === "assistant" && m.kind === "search")
    .map((m) => m.seq);
  const shown = new Set(searchSeqs.slice(-RESULT_BLOCKS_SHOWN));

  return (
    // role="log": yeni mesajlar kibarca duyurulur, geçmiş yeniden okunmaz.
    <ol
      className={styles.thread}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label={CHAT_COPY.threadLabel}
    >
      {messages.map((message) => {
        if (message.role === "user") {
          const skipped = message.kind === "skip";
          return (
            <li key={message.id} className={`${styles.row} ${styles.rowUser}`}>
              <VisuallyHidden as="span">{CHAT_COPY.userLabel}: </VisuallyHidden>
              <p className={`${styles.bubble} ${styles.bubbleUser}`}>
                {skipped ? CHAT_COPY.skippedAnswer : message.content}
              </p>
            </li>
          );
        }

        const resultsId = `sohbet-sonuc-${message.seq}`;
        const intent = message.kind === "search" ? message.intent : null;
        const sort = intent ? parseSortKey(sortParam, intent) : "secilen";
        return (
          <li key={message.id} className={`${styles.row} ${styles.rowAssistant}`}>
            <VisuallyHidden as="span">{CHAT_COPY.assistantLabel}: </VisuallyHidden>
            <div className={styles.assistantBody}>
              <p className={`${styles.bubble} ${styles.bubbleAssistant}`}>{message.content}</p>
              {intent ? (
                <>
                  <ul className={styles.chips} aria-label={CHAT_COPY.usedInSearch}>
                    {intentChips(intent).map((chip) => (
                      <li key={chip.key} className={styles.chip}>
                        {chip.label}
                      </li>
                    ))}
                  </ul>
                  {shown.has(message.seq) ? (
                    <Suspense
                      key={sort}
                      fallback={<ResultsFallback conversationId={conversationId} sort={sort} />}
                    >
                      <ChatResults
                        intent={intent}
                        headingId={resultsId}
                        retryHref={`/sohbet/${conversationId}`}
                        conversationId={conversationId}
                        messageSeq={message.seq}
                        sort={sort}
                        helpful={message.kind === "search" ? message.helpful : null}
                      />
                    </Suspense>
                  ) : null}
                </>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
