import { readAppUrl } from "@arilla/core";
import { buildSitemapIndexXml } from "../lib/sitemap-xml.ts";

/**
 * docs/sitemap.md "Yapı": tek index, altında konuya göre bölünmüş haritalar.
 * MVP-0 kapsamı (`docs/sitemap.md` "Faz dağılımı"): yalnızca statik sayfalar
 * ve ürün parçaları - mağaza/creator/trend/alternatif sonraki fazlar.
 *
 * Next'in yerleşik `sitemap.ts` kuralı burada kullanılmaz: `generateSitemaps`
 * çocuk haritaları kendi sabit `/urun/sitemap/N.xml` biçiminde üretir, bu
 * belgenin istediği `/sitemaps/urun/N.xml` yolunu veremez.
 */
export async function GET(): Promise<Response> {
  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  const xml = buildSitemapIndexXml([
    `${appUrl}/sitemap-sayfalar.xml`,
    `${appUrl}/sitemaps/urun/index.xml`,
  ]);
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
