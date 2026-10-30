import { isProductOpen, listSitemapTrends, readAppUrl } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { articleSlugs } from "../blog/articles/index.ts";
import { buildUrlSetXml } from "../lib/sitemap-xml.ts";
import { trendPath } from "../trendler/trend-json-ld.ts";
import { isTrendSlug } from "../trendler/trend-slug.ts";

/** Trend adresleri veritabanindan gelir: derleme aninda dondurulmaz, her istekte okunur. */
export const dynamic = "force-dynamic";

/**
 * docs/sitemap.md "Statik sayfalar". Belgedeki aday liste (~150 URL: hakkında,
 * kategori, cerez...) henüz yazılmamış sayfaları da sayıyor - onları
 * haritaya koymak "ölü bağlantı" demek olurdu. Yalnızca bugün gerçekten var
 * olan genel-erişimli sayfalar listelenir; yeni statik sayfa eklendikçe
 * bu dizi büyür.
 */
/** Ürün sayfaları: yalnızca ürün açıkken (`PRODUCT_ACCESS=open`) haritaya girer. */
const PRODUCT_PAGES = ["/kesfet", "/firsatlar", "/trendler"];

const STATIC_PAGES = [
  "/",
  "/gizlilik",
  "/kosullar",
  "/cerez",
  "/iletisim",
  "/sss",
  "/kvkk-aydinlatma",
  "/affiliate-aciklamasi",
  "/sirket-bilgileri",
  "/hakkinda",
  "/blog",
  "/ortakliklar",
];

/**
 * docs/sitemap.md trend sayfalari: `/trendler`in gosterdigi trendler (`listSitemapTrends`;
 * yayin penceresi bakilmaz, karar 0158). Adres sayfanin kanonik adresiyle birebir ayni; sayfanin kabul
 * etmedigi slug (404 olurdu) haritaya girmez. Sorgu hatasi haritanin geri kalanini
 * dusurmez: trendler o istekte atlanir, hata yalnizca adiyla loglanir.
 */
async function trendPages(): Promise<string[]> {
  try {
    const trends = await listSitemapTrends(getDatabase());
    return trends.filter((trend) => isTrendSlug(trend.slug)).map((trend) => trendPath(trend.slug));
  } catch (error) {
    console.error(
      "[sitemap-sayfalar] trends failed",
      error instanceof Error ? error.name : "unknown",
    );
    return [];
  }
}

export async function GET(): Promise<Response> {
  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  const articlePages = articleSlugs().map((slug) => `/blog/${slug}`);
  const base = [...STATIC_PAGES, ...articlePages];
  // Lansman oncesi urun kapali: trend sayfalari da haritaya girmez (P2, karar 0077 §7).
  const pages = isProductOpen() ? [...base, ...PRODUCT_PAGES, ...(await trendPages())] : base;
  const xml = buildUrlSetXml(pages.map((path) => ({ loc: `${appUrl}${path}` })));
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
