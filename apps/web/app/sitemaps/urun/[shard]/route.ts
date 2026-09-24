import { listSitemapEligibleProducts, readAppUrl, SITEMAP_PRODUCT_SHARD_SIZE } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { unstable_cache } from "next/cache";
import { buildUrlSetXml } from "../../../lib/sitemap-xml.ts";

const getEligibleProducts = unstable_cache(
  (minId: number, maxId: number) => listSitemapEligibleProducts(getDatabase(), { minId, maxId }),
  ["sitemap-urun-shard"],
  { revalidate: 60 * 60 * 24 },
);

/**
 * `[shard]` "1.xml", "2.xml"... yakalar - Next dinamik segment adı .xml
 * uzantısını dahil edemez (segment yalnizca "/" ile ayrılır), sayı burada
 * ayıklanır.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shard: string }> },
): Promise<Response> {
  const { shard } = await params;
  const match = /^(\d+)\.xml$/.exec(shard);
  const shardNumber = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  if (!Number.isInteger(shardNumber) || shardNumber < 1) {
    return new Response("Bulunamadı", { status: 404 });
  }

  const appUrl = readAppUrl();
  if (!appUrl) {
    return new Response("APP_URL tanimli degil. .env.example dosyasina bakin.", { status: 500 });
  }

  const maxId = shardNumber * SITEMAP_PRODUCT_SHARD_SIZE;
  const minId = maxId - SITEMAP_PRODUCT_SHARD_SIZE;
  const products = await getEligibleProducts(minId, maxId);

  const xml = buildUrlSetXml(
    products.map((product) => ({
      loc: `${appUrl}/urun/${product.slug}`,
      lastModified: product.lastModified,
    })),
  );
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
