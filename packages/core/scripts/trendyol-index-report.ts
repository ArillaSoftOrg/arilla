/**
 * Urun sitemap dizini raporu (arastirma). Ag istegi atmaz; yalnizca yerel onbellegi okur:
 *   <tmp>/manicepte-trendyol-products/*.json  ve  <tmp>/manicepte-trendyol-landing/index.json
 *
 *   node --experimental-transform-types --no-warnings --max-old-space-size=8192 scripts/trendyol-index-report.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProductIndex, type SitemapProduct } from "../src/trendyol-landing/product-index.ts";

const dir = join(tmpdir(), "manicepte-trendyol-products");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const index = new ProductIndex();
const ids = new Set<string>();
const brandCount = new Map<string, number>();
const titleCount = new Map<string, number>();
let urls = 0;
let noImage = 0;
for (const f of files) {
  const items = JSON.parse(readFileSync(join(dir, f), "utf8")) as SitemapProduct[];
  urls += items.length;
  for (const it of items) {
    const [brand = "", rest = ""] = it.path.split("/");
    ids.add(it.path.match(/-p-(\d+)$/)?.[1] ?? it.path);
    brandCount.set(brand, (brandCount.get(brand) ?? 0) + 1);
    const key = `${brand}/${rest.replace(/-p-\d+$/, "")}`;
    titleCount.set(key, (titleCount.get(key) ?? 0) + 1);
    if (!it.imageUrl) noImage++;
  }
  index.add(items);
}

// Marka normalizasyonu: Trendyol'un marka sitemap'i (sitemap_brands -> "-x-b<id>" sayfalari).
const landing = JSON.parse(
  readFileSync(join(tmpdir(), "manicepte-trendyol-landing", "index.json"), "utf8"),
) as { path: string; facets: string }[];
const brandIdBySlug = new Map<string, string>();
for (const e of landing) {
  const m = /^b(\d+)$/.exec(e.facets);
  if (m) brandIdBySlug.set(e.path.slice(1, e.path.lastIndexOf("-x-")), m[1] as string);
}
let underKnown = 0;
let knownSlugs = 0;
for (const [slug, n] of brandCount) {
  if (brandIdBySlug.has(slug)) {
    knownSlugs++;
    underKnown += n;
  }
}
const dupGroups = [...titleCount.values()].filter((c) => c > 1);

// Referans set (gercek Chrome gozlemleri, 03 §2.2 ve 07 §4): dizinde var mi, sorgu buluyor mu?
const reference: { query: string; contentId: string }[] = [
  { query: "iPhone 16 Pro 128 GB", contentId: "857296094" },
  { query: "Adidas Samba", contentId: "813659620" },
  { query: "Adidas Samba", contentId: "5999429" },
  { query: "Nike Air Force 1", contentId: "977783209" },
  { query: "Nike Air Force 1", contentId: "904143719" },
  { query: "Siyah kadın elbise", contentId: "1199153821" },
  { query: "Siyah kadın elbise", contentId: "1157405825" },
  { query: "Sony WH-1000XM5", contentId: "312097758" },
  { query: "Sony WH-1000XM5", contentId: "802022106" },
  { query: "Sony WH-1000XM5", contentId: "961213689" },
];
const searchCache = new Map<string, Set<string>>();
const refRows = reference.map(({ query, contentId }) => {
  if (!searchCache.has(query)) {
    searchCache.set(
      query,
      new Set(
        index.search(query, 1_000_000).map((p) => p.productUrl.match(/-p-(\d+)$/)?.[1] ?? ""),
      ),
    );
  }
  return {
    query,
    contentId,
    inIndex: ids.has(contentId),
    found: searchCache.get(query)?.has(contentId),
  };
});

console.log(
  JSON.stringify(
    {
      files: files.length,
      urls,
      uniqueContentIds: ids.size,
      noImagePct: +((100 * noImage) / urls).toFixed(3),
      brandSlugs: brandCount.size,
      brandSitemapBrands: brandIdBySlug.size,
      slugsMatchingBrandSitemap: knownSlugs,
      productsUnderSitemapBrands: underKnown,
      productsUnderSitemapBrandsPct: +((100 * underKnown) / urls).toFixed(1),
      identicalTitleGroups: dupGroups.length,
      productsInIdenticalTitleGroups: dupGroups.reduce((s, c) => s + c, 0),
      queryHits: Object.fromEntries([...searchCache].map(([q, s]) => [q, s.size])),
      reference: refRows,
    },
    null,
    1,
  ),
);
