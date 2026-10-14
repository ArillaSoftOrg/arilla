/**
 * Sayfa gozlemini Trendyol urun sitemap dizinine (siralanmis benzersiz contentId'ler,
 * `trendyol-sitemap-snapshot.ts` / `<tmp>/manicepte-trendyol-ids.bin`) baglar.
 * Saf: dosya okuma cagirana aittir; burada yalnizca siralanmis Uint32Array uzerinde ikili arama.
 */

export interface SitemapGeneration {
  /** Sitemap uretiminin `lastmod`'u (or. "2026-10-12T08:51:44Z"). */
  lastmod: string;
  /** Artan sirali, tekil contentId'ler. */
  ids: Uint32Array;
}

export function hasId(sorted: Uint32Array, id: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid] as number;
    if (v === id) return true;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export type SitemapMatch =
  | { status: "in_sitemap"; lastmod: string }
  /** Sayfa var ama secilen uretimde yok: yeni ya da gecici olarak cikmis olabilir (Col Titanyum ornegi). */
  | { status: "not_in_sitemap"; lastmod: string }
  | { status: "no_content_id" };

export function matchToSitemap(contentId: string | null, gen: SitemapGeneration): SitemapMatch {
  if (!contentId || !/^\d+$/.test(contentId)) return { status: "no_content_id" };
  const n = Number(contentId);
  if (!Number.isSafeInteger(n) || n > 0xffffffff) return { status: "no_content_id" };
  return hasId(gen.ids, n)
    ? { status: "in_sitemap", lastmod: gen.lastmod }
    : { status: "not_in_sitemap", lastmod: gen.lastmod };
}
