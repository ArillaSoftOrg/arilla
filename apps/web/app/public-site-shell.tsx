import type { FooterGroup, HomeHeaderNavItem } from "@arilla/ui";
import { Container, HomeHeader, SiteFooter, SkipLink } from "@arilla/ui";
import type { ReactNode } from "react";
import { HOME_COPY } from "./home-copy.ts";
import {
  homeFooterGroups,
  type SiteSectionLinks,
  SUBPAGE_SECTION_LINKS,
  siteNavItems,
} from "./home-footer-groups.ts";
import { verifySession } from "./lib/dal.ts";
import styles from "./public-site-shell.module.css";

/** docs/design.md "Kalite tabanı": SkipLink'in hedefi, sayfada tek. */
const MAIN_ID = "icerik";

/**
 * Faz 8: public site kabugu - ana sayfa ile public alt sayfalar (`/kesfet`,
 * `/firsatlar`, `/ara`, `/giris`, `/urun/[slug]`, yasal sayfalar) ayni header
 * ve footer'i paylasir. Giris gerektiren (`/hesap`, `/kaydettiklerim`, ...) ve
 * yonetim sayfalari bu kabugu kullanmaz.
 *
 * Faz 1B: kabuk `SkipLink -> header -> <main id="icerik"> -> footer`
 * yapisinin tek sahibidir. `<main>` ve genis `Container` (yatay `--gutter`)
 * buradan gelir; sayfalar ikinci bir `<main>` veya kendi yatay kenar
 * boslugunu uretmez, daha dar genislik gerekiyorsa yalnizca
 * `max-width: var(--content-width-*)` kullanir. Kisa sayfalarda footer
 * ekranin altina yaslanir.
 */
/**
 * `aria-current="page"` icin: yalnizca `href`'i tam olarak su anki yola
 * esit olan linkler etkin sayilir (`/#trendler` gibi anchor'lar asla).
 * Yol cagirandan gelir - kabuk URL okumaz, istemci JS'i yok.
 */
function markCurrent<T extends { href: string }>(
  items: readonly T[],
  currentPath: string | undefined,
): readonly (T & { current?: boolean })[] {
  if (!currentPath) return items;
  return items.map((item) => (item.href === currentPath ? { ...item, current: true } : item));
}

export async function PublicSiteShell({
  links,
  currentPath,
  children,
}: {
  links: SiteSectionLinks;
  /** Su anki route (orn. "/kesfet"); verilirse eslesen header/footer linki `aria-current` alir. */
  currentPath?: string;
  children: ReactNode;
}) {
  const user = await verifySession();
  const navItems: readonly HomeHeaderNavItem[] = markCurrent(siteNavItems(links), currentPath);
  const footerGroups: readonly FooterGroup[] = homeFooterGroups(links).map((group) => ({
    ...group,
    links: markCurrent(group.links, currentPath),
  }));
  const loginHref = "/giris";

  return (
    <div className={styles.shell}>
      <SkipLink targetId={MAIN_ID}>{HOME_COPY.skipToContent}</SkipLink>
      <HomeHeader
        brandLabel="Arilla"
        navItems={navItems}
        navAriaLabel="Ana gezinme"
        accountHref={user ? "/hesap" : null}
        accountLabel={HOME_COPY.navAccount}
        loginHref={loginHref}
        loginLabel={HOME_COPY.loginLabel}
        accountCurrent={currentPath === (user ? "/hesap" : loginHref)}
      />
      {/* tabIndex -1: SkipLink'ten sonra odak tum tarayicilarda ana icerige tasinir. */}
      <main id={MAIN_ID} tabIndex={-1} className={styles.main}>
        <Container size="wide">{children}</Container>
      </main>
      <SiteFooter
        brandLabel="Arilla"
        brandDescription={HOME_COPY.heroSubtitle}
        groups={footerGroups}
        affiliateNotice={HOME_COPY.affiliateNotice}
        priceDisclaimer={HOME_COPY.priceDisclaimer}
        copyrightLabel={`© ${new Date().getFullYear()} Arilla`}
      />
    </div>
  );
}

/** Public alt sayfalar: bolum linkleri ana sayfaya doner (`/#trendler`, ...). */
export function SubpageShell({
  currentPath,
  children,
}: {
  /** Bkz. `PublicSiteShell.currentPath` - route'un ince `layout.tsx`'i verir. */
  currentPath?: string;
  children: ReactNode;
}) {
  return (
    <PublicSiteShell links={SUBPAGE_SECTION_LINKS} currentPath={currentPath}>
      {children}
    </PublicSiteShell>
  );
}
