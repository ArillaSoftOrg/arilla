import { buildTrendSections, type TrendSummary } from "@arilla/core";
import type { TrendSectionKey } from "./trend-copy.ts";

/** Bir kesitte en cok kac kart gorunur; fazlasi "Tum Trendler"dedir. */
export const SECTION_CARD_LIMIT: Record<Exclude<TrendSectionKey, "all">, number> = {
  featured: 6,
  now: 3,
  moda: 3,
  guzellik: 3,
  "ev-yasam": 3,
  ogrenci: 3,
  seasonal: 3,
};

/** Sayfada yukaridan asagi sira. */
const ORDER: readonly Exclude<TrendSectionKey, "all">[] = [
  "featured",
  "now",
  "moda",
  "guzellik",
  "ev-yasam",
  "ogrenci",
  "seasonal",
];

export interface TrendSectionView {
  key: Exclude<TrendSectionKey, "all">;
  trends: TrendSummary[];
}

export interface TrendsPageModel {
  sections: TrendSectionView[];
  /** Hepsi, `sort_order` sirasinda; sayfada kapali `<details>` icinde. */
  all: TrendSummary[];
}

/**
 * Ilk gorunum 50 karti yigmaz: kesit basina sinirli kart, ayni trend ikinci
 * kez gosterilmez (ustteki kesit kazanir), bos kesit hic cizilmez.
 */
export function buildTrendsPageModel(trends: readonly TrendSummary[]): TrendsPageModel {
  const grouped = buildTrendSections(trends);
  const bySection: Record<Exclude<TrendSectionKey, "all">, TrendSummary[]> = {
    featured: grouped.featured,
    now: grouped.now,
    moda: grouped.byCategory.moda,
    guzellik: grouped.byCategory.guzellik,
    "ev-yasam": grouped.byCategory["ev-yasam"],
    ogrenci: grouped.byCategory.ogrenci,
    seasonal: grouped.seasonal,
  };

  const seen = new Set<number>();
  const sections: TrendSectionView[] = [];
  for (const key of ORDER) {
    const picked: TrendSummary[] = [];
    for (const trend of bySection[key]) {
      if (picked.length >= SECTION_CARD_LIMIT[key]) break;
      if (seen.has(trend.id)) continue;
      picked.push(trend);
      seen.add(trend.id);
    }
    if (picked.length > 0) sections.push({ key, trends: picked });
  }
  return { sections, all: grouped.all };
}
