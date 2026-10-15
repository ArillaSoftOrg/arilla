/**
 * Trendyol toplama kapsami: katalogdaki Trendyol teklifleri (offer.external_id = contentId) ile
 * Trendyol'un yayimladigi urun sitemap'indeki contentId'ler (research/trendyol-landing-discovery,
 * 8,13 milyon) karsilastirilir. Erisildigi VARSAYILMAZ; yalnizca olculen oran raporlanir.
 *
 * Kimlik eslemesi: sitemap `-p-<contentId>` = sayfa `product.id` = `offer.external_id`
 * (`merchant.slug = 'trendyol'`). Ayri eslesme tablosu gerekmez.
 */

export interface SitemapCoverage {
  sitemapIds: number;
  catalogIds: number;
  /** Katalogda olup sitemap uretiminde de bulunan. */
  inBoth: number;
  /** Katalogda var, sitemap uretiminde yok (yeni/gecici cikmis; silinmez, isaretlenir). */
  catalogOnly: number;
  /** inBoth / sitemapIds, yuzde (3 ondalik). */
  coveragePct: number;
}

/** `sitemapIds` artan sirali ve tekil olmalidir (snapshot betiginin ciktisi). */
export function sitemapCoverage(
  sitemapIds: Uint32Array,
  catalogExternalIds: Iterable<string>,
): SitemapCoverage {
  const ids = new Set<number>();
  for (const raw of catalogExternalIds) {
    if (/^[0-9]{1,10}$/.test(raw)) {
      const n = Number(raw);
      if (n <= 0xffffffff) ids.add(n);
    }
  }
  const sorted = Uint32Array.from(ids).sort();
  let i = 0;
  let j = 0;
  let both = 0;
  while (i < sorted.length && j < sitemapIds.length) {
    const a = sorted[i] as number;
    const b = sitemapIds[j] as number;
    if (a === b) {
      both++;
      i++;
      j++;
    } else if (a < b) i++;
    else j++;
  }
  return {
    sitemapIds: sitemapIds.length,
    catalogIds: sorted.length,
    inBoth: both,
    catalogOnly: sorted.length - both,
    coveragePct: sitemapIds.length ? Math.round((100_000 * both) / sitemapIds.length) / 1000 : 0,
  };
}
