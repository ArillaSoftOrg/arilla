import Link from "next/link";
import { CHAT_COPY } from "./chat-copy.ts";
import { CHAT_SORT_PARAM, type ChatSortKey, CLOSEST_MATCH_SUPPORTED } from "./chat-sort.ts";
import styles from "./sohbet.module.css";

const TABS: { key: ChatSortKey; label: string }[] = [
  { key: "secilen", label: CHAT_COPY.tabSelected },
  { key: "firsat", label: CHAT_COPY.tabDeals },
  { key: "eslesme", label: CHAT_COPY.tabMatches },
];

/**
 * Seçtiklerimiz / En iyi fırsatlar / En iyi eşleşmeler + sağda sonuç sayısı.
 * Sekmeler düz bağlantıdır: aynı sohbet, aynı niyet, yalnızca `?sirala=` değişir; model
 * çağrılmaz, mevcut arama yeniden çalışır. Etkin sekme renk + kalın yazı + `aria-current`.
 */
export function ResultTabs({
  conversationId,
  active,
  countLabel,
}: {
  conversationId: string;
  active: ChatSortKey;
  /** "75 sonuç"; yakın sonuç ya da yüklenirken boş. */
  countLabel: string | null;
}) {
  return (
    <div className={styles.tabsRow}>
      <nav aria-label={CHAT_COPY.tabsLabel}>
        <ul className={styles.tabs}>
          {TABS.map((tab) => {
            const disabled = tab.key === "eslesme" && !CLOSEST_MATCH_SUPPORTED;
            const isActive = tab.key === active;
            if (disabled) {
              return (
                <li key={tab.key}>
                  <span
                    className={`${styles.tab} ${styles.tabDisabled}`}
                    aria-disabled="true"
                    title={CHAT_COPY.tabMatchesUnavailable}
                  >
                    {tab.label}
                  </span>
                </li>
              );
            }
            return (
              <li key={tab.key}>
                <Link
                  className={`${styles.tab} ${isActive ? styles.tabActive : ""}`}
                  href={`/sohbet/${conversationId}?${CHAT_SORT_PARAM}=${tab.key}`}
                  scroll={false}
                  prefetch={false}
                  aria-current={isActive ? "true" : undefined}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {countLabel ? (
        <p className={styles.resultsCount} role="status">
          {countLabel}
        </p>
      ) : null}
    </div>
  );
}
