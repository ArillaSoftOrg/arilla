/**
 * Trendyol canli urun kesfi PROTOTIPI (docs/decisions/0126).
 *
 * Model, Jina, Gemini, veritabani, Redis YOK. Hicbir sey saklanmaz. Arama
 * sayfasi (/sr?q=) robots.txt ile yasak oldugu icin KULLANILMAZ; kesif:
 *   sorgu -> sitemap kategorisi -> kategori sayfasindaki JSON-LD ItemList
 *   -> (gerekirse) urun sayfalarindaki isRelatedTo baglantilari
 *   -> eslesen urunlerin urun sayfasinda JSON-LD ile dogrulanmasi.
 */

import { extractListingProducts, extractProductPage, type LiveProduct } from "./extract.ts";
import { matchTitle, queryWords, tokenize } from "./match.ts";
import type { PoliteFetcher } from "./polite-fetcher.ts";

export interface DiscoverOptions {
  query: string;
  limit?: number;
  /** Eslesme bulunamazsa isRelatedTo uzerinden en fazla kac urun sayfasi gezilir. */
  maxExpansionPages?: number;
  merchant?: string;
  /** Sitemap metni onbellekten gelirse ag istegi harcanmaz. */
  loadCachedSitemap?: () => Promise<string | null>;
  saveCachedSitemap?: (xml: string) => Promise<void>;
}

export interface DiscoverTrace {
  category: string | null;
  listingItems: number;
  listingMatches: number;
  expansionPagesFetched: number;
  rejected: Record<string, number>;
  requestCount: number;
  blocked: { status: number; url: string } | null;
  robotsSkipped: string[];
  stoppedBecause: string | null;
}

export interface DiscoverResult {
  query: string;
  products: LiveProduct[];
  trace: DiscoverTrace;
}

/** Kategori sitemap'inden sorguya en cok uyan tek kategori adresi. */
export function pickCategory(sitemapXml: string, query: string, origin: string): string | null {
  const words = queryWords(query);
  if (words.length === 0) return null;
  let best: { url: string; score: number; len: number } | null = null;
  for (const m of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = m[1] ?? "";
    if (!url.startsWith(`${origin}/`) || !/-x-c\d+$/.test(url)) continue;
    const slug = tokenize(
      url
        .slice(origin.length + 1)
        .replace(/-x-c\d+$/, "")
        .replace(/-/g, " "),
    );
    const slugSet = new Set(slug);
    const score = words.filter((w) => slugSet.has(w)).length;
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && slug.length < best.len)) {
      best = { url, score, len: slug.length };
    }
  }
  return best?.url ?? null;
}

function slugTitle(productUrl: string): string {
  const path = new URL(productUrl).pathname;
  return path
    .slice(path.lastIndexOf("/") + 1)
    .replace(/-p-\d+$/, "")
    .replace(/-/g, " ");
}

export async function discoverProducts(
  fetcher: PoliteFetcher,
  options: DiscoverOptions,
): Promise<DiscoverResult> {
  const { query } = options;
  const limit = options.limit ?? 3;
  const maxExpansion = options.maxExpansionPages ?? 6;
  const merchant = options.merchant ?? "Trendyol";
  const origin = fetcher.opts.origin;
  const trace: DiscoverTrace = {
    category: null,
    listingItems: 0,
    listingMatches: 0,
    expansionPagesFetched: 0,
    rejected: {},
    requestCount: 0,
    blocked: null,
    robotsSkipped: [],
    stoppedBecause: null,
  };
  const finish = (products: LiveProduct[]): DiscoverResult => {
    trace.requestCount = fetcher.requestCount;
    trace.blocked = fetcher.blockedBy;
    trace.robotsSkipped = [...fetcher.skippedByRobots];
    return { query, products, trace };
  };
  const reject = (reason: string) => {
    const key = reason.split(":")[0] ?? reason;
    trace.rejected[key] = (trace.rejected[key] ?? 0) + 1;
  };

  if (!(await fetcher.loadRobots())) {
    trace.stoppedBecause = "robots.txt yuklenemedi; tarama yapilmadi";
    return finish([]);
  }

  // 1) kategori
  let sitemap = (await options.loadCachedSitemap?.()) ?? null;
  if (!sitemap) {
    const res = await fetcher.get(`${origin}/sitemap_categories.xml`);
    if (!res.ok) {
      trace.stoppedBecause = `kategori sitemap'i alinamadi (${res.reason})`;
      return finish([]);
    }
    sitemap = res.body;
    await options.saveCachedSitemap?.(sitemap);
  }
  const category = pickCategory(sitemap, query, origin);
  trace.category = category;
  if (!category) {
    trace.stoppedBecause = "sorguya uyan kategori bulunamadi";
    return finish([]);
  }

  // 2) kategori sayfasi
  const listing = await fetcher.get(category);
  if (!listing.ok) {
    trace.stoppedBecause = `kategori sayfasi alinamadi (${listing.reason}${listing.status ? ` ${listing.status}` : ""})`;
    return finish([]);
  }
  const ctx = { origin, merchant, checkedAt: listing.fetchedAt, pageUrl: category };
  const listed = extractListingProducts(listing.body, ctx);
  trace.listingItems = listed.length;

  const matched = new Map<string, LiveProduct>();
  const seen = new Set<string>();
  const consider = (p: LiveProduct, title: string) => {
    if (seen.has(p.productUrl)) return false;
    seen.add(p.productUrl);
    const m = matchTitle(title, query);
    if (!m.ok) {
      reject(m.reason ?? "no-match");
      return false;
    }
    matched.set(p.productUrl, p);
    return true;
  };
  for (const p of listed) consider(p, p.title ?? slugTitle(p.productUrl));
  trace.listingMatches = matched.size;

  // 3) eslesme yoksa isRelatedTo grafiginde sinirli gezinti. Yalnizca sorgu
  //    belirteclerinin cogunu iceren urun sayfalari gezilir (ornegin "iphone 16").
  if (matched.size < limit) {
    const qTokens = tokenize(query);
    const frontier: string[] = [];
    const queued = new Set<string>();
    const overlap = (url: string) => {
      const t = new Set(tokenize(slugTitle(url)));
      return qTokens.filter((q) => t.has(q)).length;
    };
    const enqueue = (urls: string[]) => {
      for (const u of urls) {
        if (queued.has(u) || seen.has(u)) continue;
        // Slug eslesiyorsa dogrudan aday; degilse yalnizca kismi ortusme gezinti havuzuna girer.
        if (matchTitle(slugTitle(u), query).ok) {
          queued.add(u);
          frontier.unshift(u);
        } else if (overlap(u) >= Math.max(1, qTokens.length - 3)) {
          queued.add(u);
          frontier.push(u);
        }
      }
    };
    enqueue(listed.map((p) => p.productUrl));
    for (const p of listed) enqueue(p.relatedUrls);

    while (
      matched.size < limit &&
      frontier.length > 0 &&
      trace.expansionPagesFetched < maxExpansion
    ) {
      const url = frontier.shift() as string;
      const page = await fetcher.get(url);
      if (!page.ok) {
        if (page.reason === "blocked" || page.reason === "budget-exhausted") {
          trace.stoppedBecause = page.reason;
          break;
        }
        continue;
      }
      trace.expansionPagesFetched += 1;
      const product = extractProductPage(page.body, {
        ...ctx,
        pageUrl: url,
        checkedAt: page.fetchedAt,
      });
      if (!product) continue;
      consider(product, product.title ?? slugTitle(url));
      enqueue(product.relatedUrls);
    }
  }

  // 4) Liste verisinden gelen eslesmeleri urun sayfasiyla dogrula (taze fiyat/stok).
  const out: LiveProduct[] = [];
  for (const p of matched.values()) {
    if (out.length >= limit) break;
    if (p.source === "json-ld") {
      out.push(p);
      continue;
    }
    const page = await fetcher.get(p.productUrl);
    if (!page.ok) {
      if (page.reason === "blocked" || page.reason === "budget-exhausted") {
        trace.stoppedBecause = page.reason;
        break;
      }
      continue; // dogrulanamayan urun sonuca konmaz
    }
    const verified = extractProductPage(page.body, {
      ...ctx,
      pageUrl: p.productUrl,
      checkedAt: page.fetchedAt,
    });
    if (verified?.title && matchTitle(verified.title, query).ok) out.push(verified);
  }
  if (out.length === 0 && !trace.stoppedBecause) {
    trace.stoppedBecause = "izinli yollarda sorguyla eslesen urun bulunamadi";
  }
  return finish(out);
}
