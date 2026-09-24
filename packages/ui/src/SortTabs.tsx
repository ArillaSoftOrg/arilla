import styles from "./SortTabs.module.css";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

export interface SortTab {
  value: string;
  label: string;
  href: string;
  active: boolean;
  /** orn. "En yakın eşleşmeler": anchor urun yoksa anlamsiz, tiklanamaz gosterilir. */
  disabled?: boolean;
  /**
   * Devre disi sekmenin neden tiklanamadigini ekran okuyucuya soyler
   * (orn. "Bu arama için kullanılamıyor"). Gorunmez; metni cagiran saglar.
   */
  disabledHint?: string;
}

/**
 * docs/pages.md "/ara": "Sekmeler | Üç sekme, varsayılan 'Bizim seçtiklerimiz'".
 * Baglanti tabanlidir (JS'siz, `?sort=`); secili sekme `aria-current` tasir.
 * Devre disi sekme baglanti degildir (odaklanamaz); nedeni `disabledHint`
 * ile ekran okuyucuya soylenir.
 */
export function SortTabs({ tabs }: { tabs: readonly SortTab[] }) {
  return (
    <nav className={styles.nav} aria-label="Sıralama">
      {/* list-style: none WebKit'te liste rolunu dusurur; rol acikca verilir. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: yukaridaki WebKit/VoiceOver davranisi. */}
      <ul className={styles.tabs} role="list">
        {tabs.map((tab) => (
          <li key={tab.value} className={styles.item}>
            {tab.disabled ? (
              <span className={`${styles.tab} ${styles.disabled}`}>
                {tab.label}
                {tab.disabledHint ? (
                  <VisuallyHidden>{` (${tab.disabledHint})`}</VisuallyHidden>
                ) : null}
              </span>
            ) : (
              <a
                href={tab.href}
                className={tab.active ? `${styles.tab} ${styles.active}` : styles.tab}
                aria-current={tab.active ? "page" : undefined}
              >
                {tab.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
