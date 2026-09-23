import { HomeHeader, SiteFooter } from "@arilla/ui";
import type { ReactNode } from "react";
import { HOME_COPY } from "./home-copy.ts";
import {
  homeFooterGroups,
  type SiteSectionLinks,
  SUBPAGE_SECTION_LINKS,
  siteNavItems,
} from "./home-footer-groups.ts";
import { verifySession } from "./lib/dal.ts";

/**
 * Faz 8: public site kabugu - ana sayfa ile public alt sayfalar (`/kesfet`,
 * `/firsatlar`, `/ara`, `/giris`, `/urun/[slug]`, yasal sayfalar) ayni header
 * ve footer'i paylasir. Alt sayfaya dogrudan girilince "bitmemis sayfa"
 * hissi olmasin diye. Giris gerektiren (`/hesap`, `/kaydettiklerim`, ...) ve
 * yonetim sayfalari bu kabugu kullanmaz.
 *
 * `<main>` icermez - her sayfa kendi `<main>`'ini render eder. Kisa
 * sayfalarda (bos durum) footer ekranin altina yaslanir.
 */
export async function PublicSiteShell({
  links,
  children,
}: {
  links: SiteSectionLinks;
  children: ReactNode;
}) {
  const user = await verifySession();

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <HomeHeader
        brandLabel="Arilla"
        navItems={siteNavItems(links)}
        navAriaLabel="Ana gezinme"
        accountHref={user ? "/hesap" : null}
        accountLabel={HOME_COPY.navAccount}
        loginHref="/giris"
        loginLabel={HOME_COPY.loginLabel}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
      <SiteFooter
        brandLabel="Arilla"
        brandDescription={HOME_COPY.heroSubtitle}
        groups={homeFooterGroups(links)}
        affiliateNotice={HOME_COPY.affiliateNotice}
        priceDisclaimer={HOME_COPY.priceDisclaimer}
        copyrightLabel={`© ${new Date().getFullYear()} Arilla`}
      />
    </div>
  );
}

/**
 * Alt sayfa icerigini header/footer ile ayni genis konteynere hizalar. Alt
 * sayfalarin mevcut `<main style={{ padding: 24 }}>`'i bu konteynerin
 * icinde kalir - header'in ic boslugu da 24px oldugu icin sol kenarlar
 * ust uste gelir.
 */
export function SubpageShell({ children }: { children: ReactNode }) {
  return (
    <PublicSiteShell links={SUBPAGE_SECTION_LINKS}>
      <div
        style={{
          flex: 1,
          width: "100%",
          maxWidth: "var(--content-width-wide)",
          marginInline: "auto",
        }}
      >
        {children}
      </div>
    </PublicSiteShell>
  );
}
