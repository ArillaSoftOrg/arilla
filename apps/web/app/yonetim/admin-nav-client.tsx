"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./admin.module.css";
import { activeNavHref } from "./admin-nav.ts";

export interface AdminNavLink {
  href: string;
  label: string;
  description?: string;
}

export interface AdminNavSection {
  label: string;
  items: AdminNavLink[];
}

function hrefsOf(sections: AdminNavSection[]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.href));
}

/**
 * Yan menü. Liste sunucuda yetkiye göre süzülür (layout); bu bileşen
 * yalnızca etkin bağlantıyı işaretler (en özel eşleşme, `activeNavHref`).
 * İki düzey: grup adı bir etikettir (bağlantı değil, listeyi
 * `aria-labelledby` ile adlandırır), altındaki öğeler sayfa bağlantılarıdır.
 */
export function AdminNavClient({ sections }: { sections: AdminNavSection[] }) {
  const pathname = usePathname();
  const activeHref = activeNavHref(hrefsOf(sections), pathname);
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
                const active = item.href === activeHref;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={item.description}
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

/**
 * Sayfanın üstündeki konum yolu: Yönetim › grup › sayfa (› Ayrıntı). Menüyle
 * aynı (yetkiye göre süzülmüş) listeden türetilir; adres bir menü öğesinin
 * alt sayfasıysa son halka "Ayrıntı" olur. Genel bakışta gösterilmez.
 */
export function AdminBreadcrumbs({ sections }: { sections: AdminNavSection[] }) {
  const pathname = usePathname();
  const activeHref = activeNavHref(hrefsOf(sections), pathname);
  if (!activeHref || activeHref === "/yonetim") return null;
  const section = sections.find((s) => s.items.some((item) => item.href === activeHref));
  const item = section?.items.find((i) => i.href === activeHref);
  if (!section || !item) return null;
  const isDetail = pathname !== activeHref;
  return (
    <nav aria-label="Konum" className={styles.breadcrumbs}>
      <ol className={styles.breadcrumbList}>
        <li>
          <Link href="/yonetim">Yönetim</Link>
        </li>
        <li>{section.label}</li>
        <li>
          {isDetail ? (
            <Link href={item.href}>{item.label}</Link>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </li>
        {isDetail ? (
          <li>
            <span aria-current="page">Ayrıntı</span>
          </li>
        ) : null}
      </ol>
      {!isDetail && item.description ? (
        <p className={styles.breadcrumbNote}>{item.description}</p>
      ) : null}
    </nav>
  );
}
