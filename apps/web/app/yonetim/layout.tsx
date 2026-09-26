import { hasCapability } from "@arilla/core";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireCapability } from "../lib/dal.ts";
import styles from "./admin.module.css";
import { ADMIN_NAV } from "./admin-nav.ts";
import { AdminNavClient } from "./admin-nav-client.tsx";

export const metadata: Metadata = {
  title: "Yönetim",
  robots: { index: false, follow: false },
};

const ROLE_LABEL: Record<string, string> = {
  moderator: "Moderatör",
  admin: "Yönetici",
};

/**
 * `/yonetim` kabuğu (docs/decisions/0039). Buradaki `requireCapability`
 * yalnızca kolaylıktır: layout her gezinmede yeniden çalışmaz ve server
 * action'ları korumaz. Her sayfa ve action kendi yeteneğini ayrıca ister.
 */
export default async function YonetimLayout({ children }: { children: ReactNode }) {
  const { user } = await requireCapability("admin.access");
  const sections = ADMIN_NAV.map((group) => ({
    label: group.label,
    items: group.items
      .filter((item) => hasCapability(user.role, item.capability))
      .map(({ href, label }) => ({ href, label })),
  })).filter((group) => group.items.length > 0);

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <a href="/yonetim" className={styles.brandTitle}>
            Arilla yönetim
          </a>
          <span className={styles.meta}>{ROLE_LABEL[user.role] ?? user.role}</span>
        </div>
        <AdminNavClient sections={sections} />
        <div className={styles.sidebarFooter}>
          <a href="/" className={styles.navLink}>
            Siteye dön
          </a>
        </div>
      </aside>
      <main id="icerik" className={styles.main}>
        {children}
      </main>
    </div>
  );
}
