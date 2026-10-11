/**
 * Trendyol "liste sayfasi" kesfi PROTOTIPI. Model, veritabani, Redis yok.
 *
 *   sorgu -> (Trendyol'un yayinladigi) arama kombinasyonu dizini -> en uygun
 *   1-3 liste sayfasi -> sayfaya gomulu urun JSON'u -> urun duzeyinde eslesme
 *
 * Arama yolu (/sr) ve sayfalama (?pi=) robots.txt ile yasak oldugu icin
 * kullanilmaz. Liste sayfasini HTML olarak getiren `transport` disaridan
 * verilir; 403/429'da tum kesif durur, baska istemciyle yeniden DENENMEZ.
 */

import { type LandingEntry, resolveLandings } from "./landing-index.ts";
import { findSearchProps, listingProducts, type TrendyolListingProduct } from "./listing.ts";
import { matchProduct } from "./match.ts";
import { isAllowed, type RobotsRules } from "./robots.ts";

export type Transport = (url: string) => Promise<{ status: number; body: string }>;

export interface DiscoverOptions {
  query: string;
  index: LandingEntry[];
  robots: RobotsRules;
  transport: Transport;
  limit?: number;
  maxPages?: number;
  now?: () => Date;
}

export interface PageTrace {
  url: string;
  status: number | "robots-disallowed" | "network";
  listed: number;
  matched: number;
}

export interface DiscoverResult {
  query: string;
  landings: string[];
  pages: PageTrace[];
  products: TrendyolListingProduct[];
  stoppedBecause: string | null;
}

export async function discoverTrendyol(opts: DiscoverOptions): Promise<DiscoverResult> {
  const limit = opts.limit ?? 3;
  const now = opts.now ?? (() => new Date());
  const candidates = resolveLandings(opts.index, opts.query, opts.maxPages ?? 3);
  const result: DiscoverResult = {
    query: opts.query,
    landings: candidates.map((c) => c.entry.path),
    pages: [],
    products: [],
    stoppedBecause: null,
  };
  if (candidates.length === 0) {
    result.stoppedBecause = "dizinde sorguya uyan liste sayfasi yok";
    return result;
  }
  const seen = new Set<string>();
  for (const c of candidates) {
    if (result.products.length >= limit) break;
    const url = `https://www.trendyol.com${c.entry.path}`;
    if (!isAllowed(opts.robots, c.entry.path)) {
      result.pages.push({ url, status: "robots-disallowed", listed: 0, matched: 0 });
      continue;
    }
    let res: { status: number; body: string };
    try {
      res = await opts.transport(url);
    } catch {
      result.pages.push({ url, status: "network", listed: 0, matched: 0 });
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      result.pages.push({ url, status: res.status, listed: 0, matched: 0 });
      result.stoppedBecause = `HTTP ${res.status}: kesif durduruldu (engel asilmaz)`;
      break;
    }
    if (res.status !== 200) {
      result.pages.push({ url, status: res.status, listed: 0, matched: 0 });
      continue;
    }
    const listed = listingProducts(findSearchProps(res.body), now().toISOString());
    const matched = listed.filter(
      (p) =>
        p.title !== null &&
        p.productUrl !== null &&
        !seen.has(p.productUrl) &&
        // Sayfa kapsami yalnizca "-x-" filtre sayfalarinda gecerlidir; "-y-s"
        // arama terimi sayfalari filtre degil, arama sonucudur (canli testte
        // "WH-1000XM5" sayfasinda kulak ici "WF-1000XM5" de vardi).
        matchProduct(
          p.title,
          opts.query,
          p.category,
          c.entry.path.includes("-x-") ? c.covered : [],
        ),
    );
    for (const p of matched) seen.add(p.productUrl as string);
    result.pages.push({ url, status: 200, listed: listed.length, matched: matched.length });
    result.products.push(...matched);
  }
  result.products = result.products.slice(0, limit);
  if (result.products.length === 0 && !result.stoppedBecause) {
    result.stoppedBecause = "liste sayfalarinda sorguyla eslesen urun yok";
  }
  return result;
}
