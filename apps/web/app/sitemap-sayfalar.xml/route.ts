import { isProductOpen, readAppUrl } from "@arilla/core";
import { buildUrlSetXml } from "../lib/sitemap-xml.ts";

/**
 * docs/sitemap.md "Statik sayfalar". Belgedeki aday liste (~150 URL: hakkında,
 * kategori, cerez...) henüz yazılmamış sayfaları da sayıyor - onları
 * haritaya koymak "ölü bağlantı" demek olurdu. Yalnızca bugün gerçekten var
 * olan genel-erişimli sayfalar listelenir; yeni statik sayfa eklendikçe
 * bu dizi büyür.
 */
/** Ürün sayfaları: yalnızca ürün açıkken (`PRODUCT_ACCESS=open`) haritaya girer. */
const PRODUCT_PAGES = ["/kesfet", "/firsatlar"];

const STATIC_PAGES = [
  "/",
  "/gizlilik",
  "/kosullar",
  "/cerez",
  "/iletisim",
  "/kvkk-aydinlatma",
  "/affiliate-aciklamasi",
  "/sirket-bilgileri",
];

export async function GET(): Promise<Response> {
  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  const pages = isProductOpen() ? [...STATIC_PAGES, ...PRODUCT_PAGES] : STATIC_PAGES;
  const xml = buildUrlSetXml(pages.map((path) => ({ loc: `${appUrl}${path}` })));
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
