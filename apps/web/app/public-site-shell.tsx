import {
  ADMIN_LOGIN_PATH,
  canAccessProduct,
  EARLY_ACCESS_LOGIN_PATH,
  EARLY_ACCESS_PATH,
} from "@arilla/core";
import type { FooterGroup, HomeHeaderNavItem } from "@arilla/ui";
import { Container, HomeHeader, SiteFooter, SkipLink } from "@arilla/ui";
import type { ReactNode } from "react";
import { COMING_SOON_COPY } from "./coming-soon-copy.ts";
import { EARLY_ACCESS_COPY } from "./early-access-copy.ts";
import { EditorialFooter } from "./editorial-footer.tsx";
import { HOME_COPY } from "./home-copy.ts";
import {
  earlyAccessFooterGroups,
  homeFooterGroups,
  type SiteSectionLinks,
  SUBPAGE_SECTION_LINKS,
  siteNavItems,
} from "./home-footer-groups.ts";
import { verifySession } from "./lib/dal.ts";
import { readThemePreference } from "./lib/theme-cookie.ts";
import styles from "./public-site-shell.module.css";
import { SITE_BRAND } from "./site-config.ts";
import { ThemeToggleControl } from "./theme-toggle-client.tsx";

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
 * esit olan linkler etkin sayilir (`/#nasil-calisir` gibi anchor'lar asla).
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
  fullBleed = false,
  chrome = "site",
  children,
}: {
  links: SiteSectionLinks;
  /** Su anki route (orn. "/kesfet"); verilirse eslesen header/footer linki `aria-current` alir. */
  currentPath?: string;
  /** Editoryal sayfalar: icerik `Container` icine alinmaz, tam genislik bolumler sayfanin kendisindedir. */
  fullBleed?: boolean;
  /**
   * `chat`: sohbet calisma alani (`/sohbet/*`) - footer yok, ust cubuk yalin
   * ve yapiskan (menu + marka), icerik alani kalan yuksekligi doldurur.
   * Rota ince `layout.tsx`'i secer; baska sayfalar `site` kalir.
   */
  chrome?: "site" | "chat";
  children: ReactNode;
}) {
  const isChat = chrome === "chat";
  const user = await verifySession();
  // P2: lansman öncesi ürün kapalıyken (moderatör/yönetici hariç) ürün
  // bağlantıları gösterilmez; giriş eylemi "Erken erişime katıl" olur,
  // girişli normal kullanıcının hesap bağlantısı başarı ekranına gider.
  // Yalnızca görünüm: asıl kapı her ürün sayfasında `requireProductAccess`.
  const productAccess = canAccessProduct(user);
  const accountHref = user ? (productAccess ? "/hesap" : EARLY_ACCESS_PATH) : null;
  const accountLabel = productAccess ? HOME_COPY.navAccount : EARLY_ACCESS_COPY.navStatus;
  const loginLabel = productAccess ? HOME_COPY.loginLabel : EARLY_ACCESS_COPY.cta;
  const navItems: readonly HomeHeaderNavItem[] = productAccess
    ? markCurrent(siteNavItems(links), currentPath)
    : [];
  // Lansman öncesi (karar 0043): "Admin Girişi" yalnızca anonim ziyaretçiye,
  // sade bir footer bağlantısı. Aynı giriş akışı; yetki girişten sonra
  // sunucuda rolden okunur. Girişli normal kullanıcı zaten yetkisizdir.
  const footerSource = productAccess
    ? homeFooterGroups(links)
    : earlyAccessFooterGroups(
        user
          ? [{ label: EARLY_ACCESS_COPY.navStatus, href: EARLY_ACCESS_PATH }]
          : [
              { label: EARLY_ACCESS_COPY.cta, href: EARLY_ACCESS_LOGIN_PATH },
              { label: COMING_SOON_COPY.adminLogin, href: ADMIN_LOGIN_PATH },
            ],
      );
  const footerGroups: readonly FooterGroup[] = footerSource.map((group) => ({
    ...group,
    links: markCurrent(group.links, currentPath),
  }));
  const loginHref = productAccess ? "/giris" : EARLY_ACCESS_LOGIN_PATH;
  const initialTheme = await readThemePreference();

  return (
    <div className={styles.shell}>
      <SkipLink targetId={MAIN_ID}>{HOME_COPY.skipToContent}</SkipLink>
      <HomeHeader
        brandLabel={SITE_BRAND}
        brandLogoSrc="/icon4.png"
        navItems={navItems}
        navAriaLabel="Ana gezinme"
        variant={isChat ? "chat" : "site"}
        accountHref={accountHref}
        accountLabel={accountLabel}
        loginHref={loginHref}
        loginLabel={loginLabel}
        accountCurrent={currentPath === (accountHref ?? loginHref)}
        accountAvatarUrl={user?.avatarUrl ?? null}
        accountAvatarLabel={user?.displayName ?? user?.email ?? SITE_BRAND}
        // Lansman öncesi, yalnızca anonim ziyaretçiye: sade "Admin Girişi"
        // (aynı giriş akışı, karar 0043). Yetki girişten sonra sunucuda.
        themeControl={<ThemeToggleControl initialTheme={initialTheme} />}
        themeControlLabel={HOME_COPY.themeToggleLabel}
        utilityLink={
          !productAccess && !user
            ? { label: COMING_SOON_COPY.adminLogin, href: ADMIN_LOGIN_PATH }
            : undefined
        }
      />
      {/* tabIndex -1: SkipLink'ten sonra odak tum tarayicilarda ana icerige tasinir. */}
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className={isChat ? `${styles.main} ${styles.mainChat}` : styles.main}
      >
        {fullBleed ? (
          children
        ) : (
          <Container size="wide" className={isChat ? styles.chatContainer : undefined}>
            {children}
          </Container>
        )}
      </main>
      {isChat ? null : fullBleed ? (
        <EditorialFooter
          brandLabel={SITE_BRAND}
          groups={footerGroups}
          affiliateNotice={HOME_COPY.affiliateNotice}
          affiliateLink={{ label: HOME_COPY.affiliateNoticeLink, href: "/affiliate-aciklamasi" }}
          priceDisclaimer={HOME_COPY.priceDisclaimer}
          copyrightLabel={`© ${new Date().getFullYear()} ${SITE_BRAND}`}
          legalLinks={[
            { label: HOME_COPY.navPrivacy, href: "/gizlilik" },
            { label: HOME_COPY.navTerms, href: "/kosullar" },
          ]}
        />
      ) : (
        <SiteFooter
          brandLabel={SITE_BRAND}
          brandDescription={
            productAccess ? HOME_COPY.heroSubtitle : COMING_SOON_COPY.footerDescription
          }
          groups={footerGroups}
          priceDisclaimer={HOME_COPY.priceDisclaimer}
          copyrightLabel={`© ${new Date().getFullYear()} ${SITE_BRAND}`}
        />
      )}
    </div>
  );
}

/** Public alt sayfalar: bolum linkleri ana sayfaya doner (`/#nasil-calisir`, ...). */
export function SubpageShell({
  currentPath,
  fullBleed,
  chrome,
  children,
}: {
  /** Bkz. `PublicSiteShell.currentPath` - route'un ince `layout.tsx`'i verir. */
  currentPath?: string;
  fullBleed?: boolean;
  chrome?: "site" | "chat";
  children: ReactNode;
}) {
  return (
    <PublicSiteShell
      links={SUBPAGE_SECTION_LINKS}
      currentPath={currentPath}
      fullBleed={fullBleed}
      chrome={chrome}
    >
      {children}
    </PublicSiteShell>
  );
}
