import { maxSitemapProductId, SITEMAP_PRODUCT_SHARD_SIZE } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { unstable_cache } from "next/cache";

/**
 * docs/sitemap.md "Üretim": "Haritalar toplu işle üretilir, istek anında
 * değil... ürün haritaları gecelik." `unstable_cache` bunu istek yoluna
 * dokunmadan sağlar - veritabanı günde bir kez sorgulanır, aradaki her
 * crawler isteği önbellekten döner.
 */
const getMaxProductId = unstable_cache(
  () => maxSitemapProductId(getDatabase()),
  ["sitemap-urun-max-id"],
  { revalidate: 60 * 60 * 24 },
);

/**
 * Ürün parça haritalarının mutlak adresleri. Hem kök `/sitemap.xml` hem
 * geriye uyumluluk için duran `/sitemaps/urun/index.xml` bunu kullanır - kök
 * index parçaları DOĞRUDAN listeler, çünkü sitemap protokolü iç içe
 * sitemap index'e izin vermez.
 */
export async function productShardUrls(appUrl: string): Promise<string[]> {
  const maxId = await getMaxProductId();
  // docs/sitemap.md: "Parça numarası ürün ID aralığına göre sabittir" - N.
  // parça her zaman ((N-1)*boyut, N*boyut] aralığını kapsar.
  const shardCount = Math.max(1, Math.ceil(maxId / SITEMAP_PRODUCT_SHARD_SIZE));
  return Array.from(
    { length: shardCount },
    (_, index) => `${appUrl}/sitemaps/urun/${index + 1}.xml`,
  );
}
