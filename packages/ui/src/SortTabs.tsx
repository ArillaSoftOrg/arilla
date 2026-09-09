import styles from "./SortTabs.module.css";

export interface SortTab {
  value: string;
  label: string;
  href: string;
  active: boolean;
  /** orn. "En yakın eşleşmeler": anchor urun yoksa anlamsiz, tiklanamaz gosterilir. */
  disabled?: boolean;
}

/** docs/pages.md "/ara": "Sekmeler | Üç sekme, varsayılan 'Bizim seçtiklerimiz'". */
export function SortTabs({ tabs }: { tabs: readonly SortTab[] }) {
  return (
    <nav className={styles.tabs} aria-label="Sıralama">
      {tabs.map((tab) =>
        tab.disabled ? (
          <span key={tab.value} className={`${styles.tab} ${styles.disabled}`} aria-disabled="true">
            {tab.label}
          </span>
        ) : (
          <a
            key={tab.value}
            href={tab.href}
            className={tab.active ? `${styles.tab} ${styles.active}` : styles.tab}
            aria-current={tab.active ? "true" : undefined}
          >
            {tab.label}
          </a>
        ),
      )}
    </nav>
  );
}
