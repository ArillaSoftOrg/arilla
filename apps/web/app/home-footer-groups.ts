import type { FooterGroup, HomeHeaderNavItem } from "@arilla/ui";
import { createElement } from "react";
import { COOKIE_PREFERENCES_HREF } from "./consent-copy.ts";
import { CookiePreferencesLink } from "./cookie-consent-client.tsx";
import { HOME_COPY } from "./home-copy.ts";

/**
 * Faz 8: ana sayfa bolumlerine giden uc link. Ana sayfada ayni sayfa ici
 * anchor, alt sayfalarda (public site kabugu) ana sayfaya donen `/#...` -
 * alt sayfada `#trendler` hicbir yere gitmeyen bir no-op olurdu.
 */
export interface SiteSectionLinks {
  trendsHref: string;
  discoverHref: string;
  howItWorksHref: string;
}

/** Ana sayfa: `discoverHref` kesif bolumu render edildiyse `#kesfet`, degilse `/kesfet`. */
export function homeSectionLinks(discoverHref: string): SiteSectionLinks {
  return { trendsHref: "#trendler", discoverHref, howItWorksHref: "#nasil-calisir" };
}

/**
 * Alt sayfalar. `#trendler` ve `#nasil-calisir` ana sayfada her zaman render
 * edilir (demo trend seti statik, nasil calisir kosulsuz); Kesfet ise gercek
 * `/kesfet` sayfasina gider - ana sayfanin kesif bolumu kosullu oldugu icin
 * `/#kesfet` her zaman var olmayabilir.
 */
export const SUBPAGE_SECTION_LINKS: SiteSectionLinks = {
  trendsHref: "/#trendler",
  discoverHref: "/kesfet",
  howItWorksHref: "/#nasil-calisir",
};

export function siteNavItems(links: SiteSectionLinks): readonly HomeHeaderNavItem[] {
  return [
    { label: HOME_COPY.navTrends, href: links.trendsHref },
    { label: HOME_COPY.navDiscover, href: links.discoverHref },
    { label: HOME_COPY.navHowItWorks, href: links.howItWorksHref },
  ];
}

/**
 * docs/pages.md "/" Faz 5-6: footer navigasyon verisi. YALNIZCA gercekten
 * var olan route'lar - apps/web/app/ altinda dogrudan denetlendi:
 * /kesfet, /firsatlar, /giris, /kaydettiklerim, /alarmlar, /gecmis,
 * /gizlilik, /kosullar, /cerez (hepsinin page.tsx'i mevcut). #trendler ve
 * #nasil-calisir ayni sayfadaki gercek section'lar.
 *
 * Faz 6: /gizlilik ve /kosullar TASLAK sayfalar (bkz. docs/kvkk.md "Faz 6
 * notu") - yine de gercekten var olan, calisan route'lar oldugundan dead
 * link degil.
 *
 * Faz 8.1: /iletisim eklendi (gecici public e-posta, site-config.ts).
 * Ayri bir "Destek" grubu yok - tek link, Bilgi grubunda.
 *
 * Karar 0038: "Bilgi" grubu "Yasal" oldu - yedi yasal baglanti + Iletisim.
 * /kvkk-aydinlatma, /affiliate-aciklamasi, /sirket-bilgileri gercek
 * route'lar. "Cerez Tercihleri" bir sayfa degil, paneli acan istemci
 * linkidir (JS'siz /cerez#tercihler'e duser).
 *
 * Faz 7-8: bolum linkleri cagirandan gelir (`homeSectionLinks` veya
 * `SUBPAGE_SECTION_LINKS`) - header ile ayni hedefler.
 */
export function homeFooterGroups(links: SiteSectionLinks): readonly FooterGroup[] {
  return [
    {
      title: HOME_COPY.footerProductGroupTitle,
      links: [
        { label: HOME_COPY.navTrends, href: links.trendsHref },
        { label: HOME_COPY.navDiscover, href: links.discoverHref },
        { label: HOME_COPY.navHowItWorks, href: links.howItWorksHref },
        { label: HOME_COPY.navDeals, href: "/firsatlar" },
      ],
    },
    {
      title: HOME_COPY.footerAccountGroupTitle,
      links: [
        { label: HOME_COPY.loginLabel, href: "/giris" },
        { label: HOME_COPY.navSaved, href: "/kaydettiklerim" },
        { label: HOME_COPY.navAlerts, href: "/alarmlar" },
        { label: HOME_COPY.navHistory, href: "/gecmis" },
      ],
    },
    {
      title: HOME_COPY.footerLegalGroupTitle,
      links: [
        { label: HOME_COPY.navPrivacy, href: "/gizlilik" },
        { label: HOME_COPY.navKvkk, href: "/kvkk-aydinlatma" },
        { label: HOME_COPY.navCookies, href: "/cerez" },
        { label: HOME_COPY.navTerms, href: "/kosullar" },
        { label: HOME_COPY.navAffiliate, href: "/affiliate-aciklamasi" },
        { label: HOME_COPY.navCompany, href: "/sirket-bilgileri" },
        {
          label: HOME_COPY.navCookiePreferences,
          href: COOKIE_PREFERENCES_HREF,
          render: ({ className, children }) =>
            createElement(CookiePreferencesLink, { className, children }),
        },
        { label: HOME_COPY.navContact, href: "/iletisim" },
      ],
    },
  ];
}
