import { maxSitemapProductId, readAppUrl, SITEMAP_PRODUCT_SHARD_SIZE } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { unstable_cache } from "next/cache";
import { buildSitemapIndexXml } from "../../../lib/sitemap-xml.ts";

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

export async function GET(): Promise<Response> {
  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  const maxId = await getMaxProductId();
  // docs/sitemap.md: "Parça numarası ürün ID aralığına göre sabittir" - N.
  // parça her zaman ((N-1)*boyut, N*boyut] aralığını kapsar.
  const shardCount = Math.max(1, Math.ceil(maxId / SITEMAP_PRODUCT_SHARD_SIZE));
  const locs = Array.from(
    { length: shardCount },
    (_, index) => `${appUrl}/sitemaps/urun/${index + 1}.xml`,
  );

  return new Response(buildSitemapIndexXml(locs), {
    headers: { "Content-Type": "application/xml" },
  });
}
