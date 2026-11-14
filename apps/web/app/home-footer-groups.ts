import type { FooterGroup, HomeHeaderNavItem } from "@arilla/ui";
import { createElement } from "react";
import { COOKIE_PREFERENCES_HREF } from "./consent-copy.ts";
import { CookiePreferencesLink } from "./cookie-consent-client.tsx";
import { FEEDBACK_COPY } from "./geri-bildirim/feedback-copy.ts";
import { HOME_COPY } from "./home-copy.ts";

/**
 * Ana sayfa bolumlerine giden linkler. Ana sayfada kesif ayni sayfa ici
 * anchor olabilir; alt sayfalarda gercek rotaya gider. Trendler kendi
 * rotasina (`/trendler`, karar 0077) gider.
 */
export interface SiteSectionLinks {
  trendsHref: string;
  discoverHref: string;
}

/** Ana sayfa: `discoverHref` kesif bolumu render edildiyse `#kesfet`, degilse `/kesfet`. */
export function homeSectionLinks(discoverHref: string): SiteSectionLinks {
  return { trendsHref: "/trendler", discoverHref };
}

/**
 * Alt sayfalar. Trendler gercek `/trendler` rotasina, Kesfet ise gercek
 * `/kesfet` sayfasina gider.
 */
export const SUBPAGE_SECTION_LINKS: SiteSectionLinks = {
  trendsHref: "/trendler",
  discoverHref: "/kesfet",
};

export function siteNavItems(links: SiteSectionLinks): readonly HomeHeaderNavItem[] {
  return [
    { label: HOME_COPY.navTrends, href: links.trendsHref },
    { label: HOME_COPY.navDiscover, href: links.discoverHref },
  ];
}

/**
 * Menu panelinin kisisel bolumu (oturum acik). Ic rotalar: ayni sekmede,
 * duz baglanti. Footer "Hesap" grubuyla ayni hedefler.
 */
export function personalNavLinks(): readonly HomeHeaderNavItem[] {
  return [
    { label: HOME_COPY.navSaved, href: "/kaydettiklerim" },
    { label: HOME_COPY.navAlerts, href: "/alarmlar" },
    { label: HOME_COPY.navHistory, href: "/gecmis" },
  ];
}

/**
 * docs/pages.md "/" Faz 5-6: footer navigasyon verisi. YALNIZCA gercekten
 * var olan route'lar - apps/web/app/ altinda dogrudan denetlendi:
 * /kesfet, /firsatlar, /giris, /kaydettiklerim, /alarmlar, /gecmis,
 * /gizlilik, /kosullar, /cerez, /trendler, /markalar-icin,
 * /icerik-ureticileri (hepsinin page.tsx'i mevcut).
 * Faz 6: /gizlilik ve /kosullar TASLAK sayfalar (bkz. docs/kvkk.md "Faz 6
 * notu") - yine de gercekten var olan, calisan route'lar oldugundan dead
 * link degil.
 *
 * Faz 8.1: /iletisim eklendi (gecici public e-posta, site-config.ts).
 * SSS, iletisim ve geri bildirim ust bolumdeki "Yardim" grubundadir.
 *
 * Karar 0038: "Bilgi" grubu "Yasal" oldu. Bu grup artik ana kolonlarda
 * degil, footer'in altindaki kucuk yasal listede acik adlariyla gosterilir.
 * Karar 0045: /geri-bildirim urun kapali da acik ve Yardim grubundadir.
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
        { label: HOME_COPY.navDeals, href: "/firsatlar" },
      ],
    },
    companyFooterGroup(),
    partnershipFooterGroup(),
    helpFooterGroup(),
  ];
}

/** Sirket sayfalari: urun kapaliyken de acik public editoryal sayfalar. */
function companyFooterGroup(): FooterGroup {
  return {
    title: HOME_COPY.footerCompanyGroupTitle,
    links: [
      { label: HOME_COPY.navAbout, href: "/hakkinda" },
      { label: HOME_COPY.navBlog, href: "/blog" },
    ],
  };
}

/** Ticari ve stratejik is birligi girisleri; icerikleri asamali acilir. */
function partnershipFooterGroup(): FooterGroup {
  return {
    title: HOME_COPY.footerPartnershipGroupTitle,
    links: [
      { label: HOME_COPY.navBrands, href: "/markalar-icin" },
      { label: HOME_COPY.navStores, href: "/ortakliklar" },
      { label: HOME_COPY.navCreators, href: "/icerik-ureticileri" },
    ],
  };
}

/** Footer'in ust bolumundeki urun destegi ve geri bildirim hedefleri. */
function helpFooterGroup(): FooterGroup {
  return {
    title: HOME_COPY.footerHelpGroupTitle,
    links: [
      { label: HOME_COPY.navFaq, href: "/sss" },
      { label: HOME_COPY.navContact, href: "/iletisim" },
      { label: FEEDBACK_COPY.navLabel, href: "/geri-bildirim" },
    ],
  };
}

/** Tum yasal baglantilar footer'in altindaki kucuk, acik listede kalir. */
export function legalFooterGroup(): FooterGroup {
  return {
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
    ],
  };
}

/**
 * Lansman öncesi (ürün kapalı, P2): ürün bağlantıları yerine tek erken
 * erişim bağlantısı + şirket/yardım grupları. Yasal liste ortak alt alandadır.
 */
export function earlyAccessFooterGroups(
  entries: readonly { label: string; href: string }[],
): readonly FooterGroup[] {
  return [
    { title: HOME_COPY.footerAccountGroupTitle, links: entries },
    companyFooterGroup(),
    partnershipFooterGroup(),
    helpFooterGroup(),
  ];
}

/** Landing-only reduced footer; every retained link resolves to an existing route. */
export function compactEarlyAccessFooterGroups(
  entries: readonly { label: string; href: string }[],
): readonly FooterGroup[] {
  return [
    { title: HOME_COPY.footerAccountGroupTitle, links: entries },
    {
      title: HOME_COPY.footerCompanyGroupTitle,
      links: [
        { label: HOME_COPY.navAbout, href: "/hakkinda" },
        { label: HOME_COPY.navContact, href: "/iletisim" },
      ],
    },
  ];
}
