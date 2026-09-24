import { readAppUrl } from "@arilla/core";
import { buildSitemapIndexXml } from "../../../lib/sitemap-xml.ts";
import { productShardUrls } from "../shards.ts";

/**
 * Geriye uyumluluk: kök `/sitemap.xml` artık parçaları doğrudan listeliyor
 * (iç içe index protokol dışı). Bu adres daha önce arama motorlarına
 * bildirilmiş olabileceği için aynı parça listesini sunmaya devam eder.
 */
export async function GET(): Promise<Response> {
  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  return new Response(buildSitemapIndexXml(await productShardUrls(appUrl)), {
    headers: { "Content-Type": "application/xml" },
  });
}
