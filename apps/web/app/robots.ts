import { isProductOpen, readAppUrl } from "@arilla/core";
import type { MetadataRoute } from "next";

/**
 * docs/sitemap.md "robots.txt". Belgedeki listeye, aynı "giriş gerekli /
 * indekslenmemeli" gerekçesiyle `/kaydettiklerim`, `/alarmlar` (docs/
 * routes.md "Kullanıcı (giriş gerekli)" bölümünde `/gecmis`, `/hesap` ile
 * aynı grupta) ve `/api/` (Cron uçları) eklendi - belgenin kendi listesinde
 * unutulmuş görünüyor. `/giris` kökü taranabilir kalır ki kendi noindex
 * metadata'sı görülebilsin; callback/doğrulama alt yolları `/giris/` ile
 * taranmaz.
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
        "/sohbet",
        "/kaydettiklerim",
        "/alarmlar",
        "/giris/",
        "/davet/",
        "/api/",
        // Lansman öncesi ürün kapalı: ürün yolları taranmaz (P2).
        ...(isProductOpen() ? [] : ["/urun/", "/kesfet", "/firsatlar", "/erken-erisim"]),
      ],
    },
    ...(appUrl ? { sitemap: `${appUrl}/sitemap.xml` } : {}),
  };
}
