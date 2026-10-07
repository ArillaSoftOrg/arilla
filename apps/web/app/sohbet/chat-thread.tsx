import { type ChatMessageView, intentChips } from "@arilla/core";
import { ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import { Suspense } from "react";
import { CHAT_COPY } from "./chat-copy.ts";
import { ChatResults } from "./chat-results.tsx";
import styles from "./sohbet.module.css";

/** Konuşmada ürün bloğu gösterilen en son arama sayısı; öncekiler yalnızca özet. */
export const RESULT_BLOCKS_SHOWN = 3;

function ResultsFallback() {
  return (
    <div className={styles.results}>
      <VisuallyHidden as="p" role="status">
        Sonuçlar yükleniyor
      </VisuallyHidden>
      <div className={styles.resultGrid} aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
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
export function ChatThread({ messages }: { messages: readonly ChatMessageView[] }) {
  const searchSeqs = messages
    .filter((m) => m.role === "assistant" && m.kind === "search")
    .map((m) => m.seq);
  const shown = new Set(searchSeqs.slice(-RESULT_BLOCKS_SHOWN));

  return (
    <ol className={styles.thread} aria-label={CHAT_COPY.threadLabel}>
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
                    <Suspense fallback={<ResultsFallback />}>
                      <ChatResults intent={intent} headingId={resultsId} />
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
