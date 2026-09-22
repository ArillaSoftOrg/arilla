import type { FooterGroup } from "@arilla/ui";
import { HOME_COPY } from "./home-copy.ts";

/**
 * docs/pages.md "/" Faz 5-6: footer navigasyon verisi. YALNIZCA gercekten
 * var olan route'lar - apps/web/app/ altinda dogrudan denetlendi:
 * /kesfet, /firsatlar, /giris, /kaydettiklerim, /alarmlar, /gecmis,
 * /gizlilik, /kosullar, /cerez (hepsinin page.tsx'i mevcut). #trendler ve
 * #nasil-calisir ayni sayfadaki gercek section'lar.
 *
 * Faz 6: /gizlilik ve /kosullar TASLAK sayfalar (bkz. docs/kvkk.md "Faz 6
 * notu") - yine de gercekten var olan, calisan route'lar oldugundan dead
 * link degil. "Destek"/iletisim grubu HALA eklenmedi - dogrulanabilir
 * gercek iletisim bilgisi (e-posta/telefon/adres) repoda yok.
 */
export const HOME_FOOTER_GROUPS: readonly FooterGroup[] = [
  {
    title: HOME_COPY.footerProductGroupTitle,
    links: [
      { label: HOME_COPY.navTrends, href: "#trendler" },
      { label: HOME_COPY.navDiscover, href: "/kesfet" },
      { label: HOME_COPY.navHowItWorks, href: "#nasil-calisir" },
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
    title: HOME_COPY.footerInfoGroupTitle,
    links: [
      { label: HOME_COPY.navPrivacy, href: "/gizlilik" },
      { label: HOME_COPY.navTerms, href: "/kosullar" },
      { label: HOME_COPY.navCookies, href: "/cerez" },
    ],
  },
];
