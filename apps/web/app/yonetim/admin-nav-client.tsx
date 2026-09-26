"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./admin.module.css";

export interface AdminNavLink {
  href: string;
  label: string;
}

/** Yalnızca etkin bağlantıyı işaretlemek için istemci bileşeni; liste sunucuda süzülür. */
export function AdminNavClient({ items }: { items: AdminNavLink[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Yönetim">
      <ul className={styles.navList}>
        {items.map((item) => {
          const active =
            item.href === "/yonetim"
              ? pathname === "/yonetim"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
