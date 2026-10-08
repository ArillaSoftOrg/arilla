import {
  type ChatLinkPayload,
  chatLinkFailureCopy,
  describeLinkPreferences,
  getChatLinkView,
  isChatImageEnabled,
  type LinkSource,
  loadChatLinkResults,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ProductImage, VisuallyHidden } from "@arilla/ui";
import { CHAT_LINK_COPY } from "./chat-copy.ts";
import {
  droppedNote,
  formatSourcePrice,
  hasLinkResults,
  linkScreenFor,
  unappliedNote,
} from "./chat-link-model.ts";
import { ChatLinkWaitClient } from "./chat-link-wait-client.tsx";
import { ChatResultGrid } from "./chat-results.tsx";
import styles from "./sohbet.module.css";

/**
 * Kaynak kartı: bağlam, katalog ürünü DEĞİL. Dış bağlantı yalnızca katalogda bir
 * `offer` varsa `/git/` üzerinden verilir (kural 8: attribution kaydı olmadan
 * merchant linki yok); yoksa bağlantı gösterilmez.
 */
function ChatLinkSource({
  source,
  offerId,
  headingId,
}: {
  source: LinkSource;
  offerId: number | null;
  headingId: string;
}) {
  const price = formatSourcePrice(source);
  return (
    <aside className={styles.linkSource} aria-labelledby={headingId}>
      {source.imageUrl ? (
        <div className={styles.linkSourceImage}>
          <ProductImage
            src={source.imageUrl}
            alt={source.title ?? source.site}
            aspectRatio={1}
            fit="contain"
            loading="lazy"
          />
        </div>
      ) : null}
      <div className={styles.linkSourceBody}>
        <p className={styles.linkSourceLabel} id={headingId}>
          {CHAT_LINK_COPY.sourceLabel} · {source.site}
        </p>
        {source.title ? <p className={styles.linkSourceTitle}>{source.title}</p> : null}
        {source.brand ? <p className={styles.resultsNote}>{source.brand}</p> : null}
        {price ? <p className={styles.linkSourcePrice}>{price}</p> : null}
        <p className={styles.resultsNote}>{CHAT_LINK_COPY.sourceNote}</p>
        {offerId !== null ? (
          <a
            className={styles.seeAll}
            href={`/git/${offerId}?surface=search`}
            target="_blank"
            rel="nofollow noopener noreferrer"
          >
            {CHAT_LINK_COPY.sourceOpen}
          </a>
        ) : null}
      </div>
    </aside>
  );
}

function FailureBlock({ code }: { code: string }) {
  const copy = chatLinkFailureCopy(code, { imageEnabled: isChatImageEnabled() });
  return (
    <div className={styles.results} data-link-state="failed" role="alert">
      <h3 className={styles.resultsHeading}>{copy.title}</h3>
      <p className={styles.resultsNote}>{copy.description}</p>
    </div>
  );
}

/**
 * Link `notice` mesajının altındaki sonuç bloğu (karar 0079). Durum her gösterimde
 * `requestId` ile okunur: sayfa yenilemek aynı sonucu verir. Ürünler yalnızca
 * mevcut arama katmanından gelir; hata sohbeti bozmaz, yalnız bu blok kısa bir
 * mesaja döner. Sorgu hiç açılmadıysa (`requestId` yok) mesaj metni hatayı zaten
 * söyler: ek blok yok.
 */
export async function ChatLinkResults({
  link,
  conversationId,
  messageSeq,
  headingId,
}: {
  link: ChatLinkPayload;
  conversationId: string;
  messageSeq: number;
  headingId: string;
}) {
  if (link.requestId === null) return null;
  const db = getDatabase();
  try {
    const view = await getChatLinkView(db, link);
    const screen = linkScreenFor(view);
    if (screen.kind === "pending") {
      return <ChatLinkWaitClient conversationId={conversationId} messageSeq={messageSeq} />;
    }
    if (screen.kind === "failure") return <FailureBlock code={screen.code} />;
    if (view.state !== "resolved") return null;

    const results = await loadChatLinkResults(db, link, view);
    if (!results) return null;
    const { linkState } = view;
    const prefLines = describeLinkPreferences(link.preferences);
    const unapplied = unappliedNote(results.preferences);
    const dropped = droppedNote(results.preferences);
    const sameId = `${headingId}-ayni`;
    const similarId = `${headingId}-benzer`;
    const sourceId = `${headingId}-kaynak`;
    const emptyCopy = chatLinkFailureCopy("empty", { imageEnabled: isChatImageEnabled() });

    return (
      <section className={styles.results} data-link-state="resolved" aria-labelledby={headingId}>
        <VisuallyHidden as="h3" id={headingId}>
          {CHAT_LINK_COPY.resultsRegion}
        </VisuallyHidden>
        <ChatLinkSource
          source={linkState.source}
          offerId={linkState.offerId}
          headingId={sourceId}
        />
        {screen.textOnly ? (
          <p className={styles.resultsNote}>{CHAT_LINK_COPY.textOnlyNote}</p>
        ) : null}
        {prefLines.length > 0 ? (
          <p className={styles.resultsNote}>
            {CHAT_LINK_COPY.preferencesLabel}: {prefLines.join(" · ")}
          </p>
        ) : null}
        {unapplied || dropped ? (
          <ul className={styles.relaxed}>
            {unapplied ? <li className={styles.relaxedItem}>{unapplied}</li> : null}
            {dropped ? <li className={styles.relaxedItem}>{dropped}</li> : null}
          </ul>
        ) : null}
        {results.same.length > 0 ? (
          <>
            <h4 id={sameId} className={styles.resultsHeading}>
              {CHAT_LINK_COPY.sameTitle}
            </h4>
            <p className={styles.resultsNote}>
              {CHAT_LINK_COPY.sameEvidence[results.same[0]?.evidence ?? "gtin"]}
            </p>
            <ChatResultGrid items={results.same} labelledBy={sameId} />
          </>
        ) : null}
        {results.similar.length > 0 ? (
          <>
            <h4 id={similarId} className={styles.resultsHeading}>
              {CHAT_LINK_COPY.similarTitle}
            </h4>
            <ChatResultGrid items={results.similar} labelledBy={similarId} />
          </>
        ) : null}
        {hasLinkResults(results) ? null : (
          <>
            <p className={styles.resultsHeading}>{emptyCopy.title}</p>
            <p className={styles.resultsNote}>{emptyCopy.description}</p>
          </>
        )}
      </section>
    );
  } catch (error) {
    // Yalnızca sınıf adı: hata mesajı adres taşıyabilir.
    console.error("[sohbet] link results failed", error instanceof Error ? error.name : "unknown");
    return <FailureBlock code="unexpected" />;
  }
}
