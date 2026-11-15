import { type ChatMessageView, intentChips } from "@arilla/core";
import { ProductCardSkeleton, VisuallyHidden } from "@arilla/ui";
import Link from "next/link";
import { Suspense } from "react";
import { CHAT_COPY } from "./chat-copy.ts";
import { ChatIntentControls } from "./chat-intent-controls.tsx";
import { ChatLinkResults } from "./chat-link-results.tsx";
import { openBlocksHref, parseOpenSeqs, toggleOpenSeqs } from "./chat-open.ts";
import { RestoreSearchButton } from "./chat-restore-client.tsx";
import { ChatResults } from "./chat-results.tsx";
import { ChatPendingRow, ChatUserRow } from "./chat-shell-parts.tsx";
import { type ChatSortKey, parseSortKey } from "./chat-sort.ts";
import { ResultTabs } from "./chat-tabs.tsx";
import styles from "./sohbet.module.css";

/** Konuşmada ürün bloğu gösterilen en son arama sayısı; öncekiler yalnızca özet. */
export const RESULT_BLOCKS_SHOWN = 1;

function ResultsFallback({
  conversationId,
  sort,
  uxV2 = false,
}: {
  conversationId: string;
  sort: ChatSortKey;
  uxV2?: boolean;
}) {
  return (
    <div className={styles.results} aria-busy="true">
      <ChatPendingRow label={CHAT_COPY.resultsLoading} />
      <ResultTabs conversationId={conversationId} active={sort} countLabel={null} uxV2={uxV2} />
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
  uxV2 = false,
  answerEnabled = false,
  openParam,
}: {
  messages: readonly ChatMessageView[];
  conversationId: string;
  /** `?sirala=` ham değeri; geçersizse niyetin tercihi/varsayılan. */
  sortParam?: string;
  /** Karar 0200 (`CHAT_UX_V2`): eski bloklar açılıp kapanabilir, yeni blok özet + kademeli gösterim. */
  uxV2?: boolean;
  /** Karar 0203: kullanıcı sonuç cevabı pilotunda ("Farkları açıkla" çipi). */
  answerEnabled?: boolean;
  /** `?ac=` ham değeri: açılan eski arama mesajı sıraları (en çok 2). */
  openParam?: string;
}) {
  const searchSeqs = messages
    .filter((m) => m.role === "assistant" && m.kind === "search")
    .map((m) => m.seq);
  const shown = new Set(searchSeqs.slice(-RESULT_BLOCKS_SHOWN));
  const olderSeqs = new Set(searchSeqs.filter((seq) => !shown.has(seq)));
  const open = uxV2 ? parseOpenSeqs(openParam, olderSeqs) : [];
  // "Bu aramaya dön" yalnızca eski bloklarda ve niyeti şu anki aramadan farklıysa (karar 0199).
  const latestSearch = messages.filter((m) => m.role === "assistant" && m.kind === "search").at(-1);
  const latestIntentJson =
    latestSearch?.role === "assistant" && latestSearch.kind === "search" && latestSearch.intent
      ? JSON.stringify(latestSearch.intent)
      : null;
  // Link sonuçları da yalnızca en son link mesajında çizilir (karar 0090); öncekiler özet.
  const linkSeqs = messages
    .filter((m) => m.role === "assistant" && m.kind === "notice" && m.link)
    .map((m) => m.seq);
  const linkShown = new Set(linkSeqs.slice(-RESULT_BLOCKS_SHOWN));

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
            <ChatUserRow
              key={message.id}
              text={skipped ? CHAT_COPY.skippedAnswer : message.content}
              imageSrc={message.attachmentId ? `/sohbet/gorsel/${message.attachmentId}` : null}
            />
          );
        }

        const resultsId = `sohbet-sonuc-${message.seq}`;
        const intent = message.kind === "search" ? message.intent : null;
        const sort = intent ? parseSortKey(sortParam, intent, uxV2) : "secilen";
        return (
          <li key={message.id} className={`${styles.row} ${styles.rowAssistant}`}>
            <VisuallyHidden as="span">{CHAT_COPY.assistantLabel}: </VisuallyHidden>
            <div className={styles.assistantBody}>
              <p className={`${styles.bubble} ${styles.bubbleAssistant}`}>{message.content}</p>
              {intent ? (
                <>
                  {shown.has(message.seq) ? (
                    <ChatIntentControls intent={intent} chips={intentChips(intent)} />
                  ) : (
                    <ul className={styles.chips} aria-label={CHAT_COPY.usedInSearch}>
                      {intentChips(intent).map((chip) => (
                        <li key={chip.key} className={styles.chip}>
                          {chip.label}
                        </li>
                      ))}
                    </ul>
                  )}
                  {message.kind === "search" &&
                  !shown.has(message.seq) &&
                  JSON.stringify(intent) !== latestIntentJson ? (
                    <RestoreSearchButton
                      conversationId={conversationId}
                      messageSeq={message.seq}
                      query={intent.query}
                    />
                  ) : null}
                  {uxV2 && message.kind === "search" && !shown.has(message.seq) ? (
                    <>
                      <Link
                        className={styles.olderToggle}
                        href={openBlocksHref(
                          conversationId,
                          toggleOpenSeqs(open, message.seq),
                          sortParam,
                        )}
                        scroll={false}
                        prefetch={false}
                        aria-expanded={open.includes(message.seq)}
                        aria-label={CHAT_COPY.olderLabel(intent.query)}
                      >
                        {open.includes(message.seq) ? CHAT_COPY.olderHide : CHAT_COPY.olderShow}
                      </Link>
                      {open.includes(message.seq) ? (
                        <Suspense
                          fallback={
                            <ResultsFallback conversationId={conversationId} sort="secilen" />
                          }
                        >
                          <ChatResults
                            intent={intent}
                            headingId={resultsId}
                            retryHref={openBlocksHref(conversationId, open, sortParam)}
                            conversationId={conversationId}
                            messageSeq={message.seq}
                            sort="secilen"
                            helpful={null}
                            uxV2
                            compact
                          />
                        </Suspense>
                      ) : null}
                    </>
                  ) : null}
                  {shown.has(message.seq) ? (
                    <Suspense
                      key={sort}
                      fallback={
                        <ResultsFallback conversationId={conversationId} sort={sort} uxV2={uxV2} />
                      }
                    >
                      <ChatResults
                        intent={intent}
                        headingId={resultsId}
                        retryHref={`/sohbet/${conversationId}`}
                        conversationId={conversationId}
                        messageSeq={message.seq}
                        sort={sort}
                        helpful={message.kind === "search" ? message.helpful : null}
                        explanationHelpful={
                          message.kind === "search" ? (message.explanationHelpful ?? null) : null
                        }
                        uxV2={uxV2}
                        answerEnabled={answerEnabled}
                      />
                    </Suspense>
                  ) : null}
                </>
              ) : null}
              {message.kind === "notice" && message.link && linkShown.has(message.seq) ? (
                <ChatLinkResults
                  link={message.link}
                  conversationId={conversationId}
                  messageSeq={message.seq}
                  headingId={resultsId}
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
