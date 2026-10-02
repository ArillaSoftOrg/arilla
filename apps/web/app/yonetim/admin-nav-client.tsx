"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./admin.module.css";
import { isNavItemActive } from "./admin-nav.ts";

export interface AdminNavLink {
  href: string;
  label: string;
}

export interface AdminNavSection {
  label: string;
  items: AdminNavLink[];
}

/**
 * Yan menü. Liste sunucuda yetkiye göre süzülür (layout); bu bileşen
 * yalnızca etkin bağlantıyı işaretler. İki düzey: grup adı bir etikettir
 * (bağlantı değil, listeyi `aria-labelledby` ile adlandırır), altındaki
 * öğeler sayfa bağlantılarıdır.
 */
export function AdminNavClient({ sections }: { sections: AdminNavSection[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Yönetim" className={styles.navSections}>
      {sections.map((section, index) => {
        const headingId = `yonetim-menu-${index}`;
        return (
          <div key={section.label} className={styles.navSection}>
            <span id={headingId} className={styles.navHeading}>
              {section.label}
            </span>
            <ul className={styles.navList} aria-labelledby={headingId}>
              {section.items.map((item) => {
                const active = isNavItemActive(item.href, pathname);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={
                        active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
                      }
                      aria-current={active ? "page" : undefined}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
