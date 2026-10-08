import type { TrendCategory } from "@arilla/db";
import type { TrendSummary } from "./types.ts";

/**
 * `now` pencerenin icindeyse ve trend mevsimlik/kampanya ise true. Evergreen
 * trend "su an" sayilmaz: onun zamani yoktur. Bos uc sinirsiz demektir; iki
 * ucu da bos mevsimlik trend de "su an" degildir (hangi donem oldugu bilinmiyor).
 */
export function isTrendActiveNow(
  trend: {
    trendType: string;
    activeFrom: Date | null;
    activeUntil: Date | null;
  },
  now: Date,
): boolean {
  if (trend.trendType === "evergreen") return false;
  if (trend.activeFrom === null && trend.activeUntil === null) return false;
  if (trend.activeFrom && now < trend.activeFrom) return false;
  if (trend.activeUntil && now >= trend.activeUntil) return false;
  return true;
}

/** `/trendler` kesitleri. Baslik metni arayuze aittir; burada yalniz anahtar ve icerik. */
export interface TrendSections {
  featured: TrendSummary[];
  now: TrendSummary[];
  byCategory: Record<Exclude<TrendCategory, "genel">, TrendSummary[]>;
  seasonal: TrendSummary[];
  all: TrendSummary[];
}

/** Girdi sirasi (sort_order) korunur; ayni trend birden cok kesitte yer alabilir. */
export function buildTrendSections(trends: readonly TrendSummary[]): TrendSections {
  const byCategory: TrendSections["byCategory"] = {
    moda: [],
    guzellik: [],
    "ev-yasam": [],
    ogrenci: [],
  };
  for (const trend of trends) {
    if (trend.category !== "genel") byCategory[trend.category].push(trend);
  }
  return {
    featured: trends.filter((trend) => trend.featured),
    now: trends.filter((trend) => trend.activeNow),
    byCategory,
    seasonal: trends.filter((trend) => trend.trendType !== "evergreen"),
    all: [...trends],
  };
}
