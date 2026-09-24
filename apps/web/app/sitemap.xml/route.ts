import { readAppUrl } from "@arilla/core";
import { buildSitemapIndexXml } from "../lib/sitemap-xml.ts";
import { productShardUrls } from "../sitemaps/urun/shards.ts";

/**
 * docs/sitemap.md "Yapı": tek index, altında konuya göre bölünmüş haritalar.
 * MVP-0 kapsamı (`docs/sitemap.md` "Faz dağılımı"): yalnızca statik sayfalar
 * ve ürün parçaları - mağaza/creator/trend/alternatif sonraki fazlar.
 *
 * Ürün parçaları burada DOĞRUDAN listelenir: sitemap protokolü bir index'in
 * başka bir index'i göstermesine izin vermez (`/sitemaps/urun/index.xml`
 * yalnızca geriye uyumluluk için duruyor).
 *
 * Next'in yerleşik `sitemap.ts` kuralı burada kullanılmaz: `generateSitemaps`
 * çocuk haritaları kendi sabit `/urun/sitemap/N.xml` biçiminde üretir, bu
 * belgenin istediği `/sitemaps/urun/N.xml` yolunu veremez.
 *
 * İstek anında üretilir: ürün parça sayısı veritabanından gelir (24 saat
 * `unstable_cache` - bkz. shards.ts). Statik ön-üretim build'i veritabanına
 * bağımlı kılar ve parça listesini build anına dondururdu.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  const xml = buildSitemapIndexXml([
    `${appUrl}/sitemap-sayfalar.xml`,
    ...(await productShardUrls(appUrl)),
  ]);
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
