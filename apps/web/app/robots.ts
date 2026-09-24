import { readAppUrl } from "@arilla/core";
import type { MetadataRoute } from "next";

/**
 * docs/sitemap.md "robots.txt". Belgedeki listeye, aynı "giriş gerekli /
 * indekslenmemeli" gerekçesiyle `/kaydettiklerim`, `/alarmlar` (docs/
 * routes.md "Kullanıcı (giriş gerekli)" bölümünde `/gecmis`, `/hesap` ile
 * aynı grupta), `/giris` (bir form, içerik değil) ve `/api/` (Cron uçları)
 * eklendi - belgenin kendi listesinde unutulmuş görünüyor.
 */
export default function robots(): MetadataRoute.Robots {
  const appUrl = readAppUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/git/",
        "/panel/",
        "/yonetim/",
        "/gecmis",
        "/hesap",
        "/ara",
        "/kaydettiklerim",
        "/alarmlar",
        "/giris",
        "/api/",
      ],
    },
    ...(appUrl ? { sitemap: `${appUrl}/sitemap.xml` } : {}),
  };
}
