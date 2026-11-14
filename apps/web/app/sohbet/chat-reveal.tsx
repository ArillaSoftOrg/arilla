"use client";

import { Children, type ReactNode, useId, useState } from "react";
import { CHAT_COPY } from "./chat-copy.ts";
import { REVEAL_INITIAL_COUNT, revealPlan } from "./chat-open.ts";
import styles from "./sohbet.module.css";

/**
 * Kademeli ürün gösterimi (karar 0200): ilk kartlar görünür, devamı yumuşak bir geçişle
 * soluklaşır ve geniş bir düğmeyle AYNI sayfada açılır. Kartlar sunucuda çizilir; burada yalnızca
 * kaç tanesinin görüneceği seçilir. Gizli kartların görselleri yüklenmez (DOM'a girmez).
 * İnternet kartları (`extra`) yalnızca açıkken eklenir.
 */
export function ChatResultReveal({
  children,
  extra,
  labelledBy,
  initialCount = REVEAL_INITIAL_COUNT,
  totalCount,
}: {
  children: ReactNode;
  extra?: ReactNode;
  labelledBy: string;
  initialCount?: number;
  /** Düğmedeki toplam (başta ayrı gösterilen kartlar dahil); yoksa bu listenin uzunluğu. */
  totalCount?: number;
}) {
  const items = Children.toArray(children);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { visible, needsButton } = revealPlan(items.length, expanded, initialCount);
  const showExtra = expanded || !needsButton;
  return (
    <>
      <div className={needsButton && !expanded ? styles.revealCollapsed : undefined}>
        {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür. */}
        <ul id={listId} className={styles.resultGrid} role="list" aria-labelledby={labelledBy}>
          {items.slice(0, visible)}
          {showExtra ? extra : null}
        </ul>
      </div>
      {needsButton ? (
        <button
          type="button"
          className={styles.revealButton}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? CHAT_COPY.revealLess : CHAT_COPY.revealMore(totalCount ?? items.length)}
        </button>
      ) : null}
    </>
  );
}
