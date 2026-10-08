import type { TrendHeroSource } from "./types.ts";

export interface ResolvedTrendHero {
  url: string | null;
  source: TrendHeroSource;
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
