import { isProductOpen, readAppUrl } from "@arilla/core";
import { articleSlugs } from "../blog/articles/index.ts";
import { buildUrlSetXml } from "../lib/sitemap-xml.ts";

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

export async function GET(): Promise<Response> {
  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  const articlePages = articleSlugs().map((slug) => `/blog/${slug}`);
  const base = [...STATIC_PAGES, ...articlePages];
  const pages = isProductOpen() ? [...base, ...PRODUCT_PAGES] : base;
  const xml = buildUrlSetXml(pages.map((path) => ({ loc: `${appUrl}${path}` })));
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
