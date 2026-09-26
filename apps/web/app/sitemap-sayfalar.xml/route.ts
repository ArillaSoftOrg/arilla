import { readAppUrl } from "@arilla/core";
import { buildUrlSetXml } from "../lib/sitemap-xml.ts";

/**
 * docs/sitemap.md "Statik sayfalar". Belgedeki aday liste (~150 URL: hakkında,
 * kategori, cerez...) henüz yazılmamış sayfaları da sayıyor - onları
 * haritaya koymak "ölü bağlantı" demek olurdu. Yalnızca bugün gerçekten var
 * olan genel-erişimli sayfalar listelenir; yeni statik sayfa eklendikçe
 * bu dizi büyür.
 */
const STATIC_PAGES = [
  "/",
  "/kesfet",
  "/firsatlar",
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

  const xml = buildUrlSetXml(STATIC_PAGES.map((path) => ({ loc: `${appUrl}${path}` })));
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
