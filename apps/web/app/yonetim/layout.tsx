import { hasCapability } from "@arilla/core";
import { SkipLink } from "@arilla/ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireCapability } from "../lib/dal.ts";
import { SITE_BRAND } from "../site-config.ts";
import styles from "./admin.module.css";
import { ADMIN_NAV } from "./admin-nav.ts";
import { AdminBreadcrumbs, AdminMobileNav, AdminNavClient } from "./admin-nav-client.tsx";

export const metadata: Metadata = {
  title: "Yönetim",
  robots: { index: false, follow: false },
};

const ROLE_LABEL: Record<string, string> = {
  moderator: "Moderatör",
  admin: "Yönetici",
};

/**
 * `/yonetim` kabuğu (docs/decisions/0039, 0083). Buradaki `requireCapability`
 * yalnızca kolaylıktır: layout her gezinmede yeniden çalışmaz ve server
 * action'ları korumaz. Her sayfa ve action kendi yeteneğini ayrıca ister.
 *
 * Düzen: ≥ 1024px'te sabit yan menü + üst çubukta konum yolu; daha darda
 * üst çubukta "Menü" düğmesi aynı menüyü çekmecede açar. Menü sunucuda
 * yetkiye göre süzülür; gizlenen bağlantı yetki değildir.
 */
export default async function YonetimLayout({ children }: { children: ReactNode }) {
  const { user } = await requireCapability("admin.access");
  const sections = ADMIN_NAV.map((group) => ({
    label: group.label,
    items: group.items
      .filter((item) => hasCapability(user.role, item.capability))
      .map(({ href, label, description }) => ({ href, label, description })),
  })).filter((group) => group.items.length > 0);
  const roleLabel = ROLE_LABEL[user.role] ?? user.role;

  return (
    <div className={styles.shell}>
      <SkipLink>İçeriğe geç</SkipLink>
      <aside className={styles.sidebar} aria-label="Yönetim menüsü">
        <div className={styles.brand}>
          <a href="/yonetim" className={styles.brandTitle}>
            {SITE_BRAND}
            <span className={styles.brandSub}>Yönetim konsolu</span>
          </a>
          <span className={styles.roleBadge}>{roleLabel}</span>
        </div>
        <div className={styles.sidebarScroll}>
          <AdminNavClient sections={sections} />
        </div>
        <div className={styles.sidebarFooter}>
          <a href="/" className={styles.navLink}>
            Siteye dön
          </a>
        </div>
      </aside>
      <div className={styles.mainColumn}>
        <header className={styles.topbar}>
          <AdminMobileNav sections={sections} brand={SITE_BRAND} roleLabel={roleLabel} />
          <AdminBreadcrumbs sections={sections} />
        </header>
        <main id="icerik" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
