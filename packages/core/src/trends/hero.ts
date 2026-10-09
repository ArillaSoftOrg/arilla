import type { TrendHeroSource } from "./types.ts";

export interface ResolvedTrendHero {
  url: string | null;
  source: TrendHeroSource;
}

/** Kapak icin tarayicida denenecek en cok aday sayisi. */
export const MAX_HERO_CANDIDATES = 5;

/**
 * Kapak adaylari (karar 0077): once trendin kendi gorseli, sonra en iyi eslesen
 * urunlerin gorselleri, tekrarsiz. Gorsel canlilik sunucuda DENETLENMEZ; istemci
 * `FallbackImage` sirayla dener, hepsi kirikse yer tutucu cizer.
 */
export function heroCandidateUrls(
  heroImageUrl: string | null | undefined,
  productImageUrls: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  for (const raw of [heroImageUrl, ...productImageUrls]) {
    const url = raw?.trim();
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= MAX_HERO_CANDIDATES) break;
  }
  return out;
}

/**
 * Kapak onceligi: trendin kendi editoryal gorseli -> en iyi eslesen
 * (sort_order 0) urunun gorseli -> yer tutucu (`url: null`; arayuz notr
 * `--surface` kutusu cizer). Bos/bosluk dizgi "yok" sayilir.
 */
export function resolveTrendHero(
  heroImageUrl: string | null | undefined,
  representativeProductImageUrl: string | null | undefined,
): ResolvedTrendHero {
  const own = heroImageUrl?.trim();
  if (own) return { url: own, source: "trend" };
  const product = representativeProductImageUrl?.trim();
  if (product) return { url: product, source: "product" };
  return { url: null, source: "placeholder" };
}
