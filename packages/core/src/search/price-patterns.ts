/**
 * Fiyat kaliplari (docs/search.md, Kademe 2): "3000 tl altı", "3000 altında",
 * "-3000₺", "2000-3000 arası". Sonuc kurus cinsinden (CLAUDE.md: para float
 * degil, tamsayi kurus).
 */

export interface PriceMatch {
  start: number;
  end: number;
  priceMin?: number;
  priceMax?: number;
}

function parseTlToKurus(raw: string): number {
  const cleaned = raw.replace(/\./g, "");
  return Number.parseInt(cleaned, 10) * 100;
}

/** Normalize edilmis (kucuk harf) metin uzerinde calisir. */
export function extractPricePatterns(text: string): PriceMatch[] {
  const matches: PriceMatch[] = [];
  const consumedRanges: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    consumedRanges.some(([s, e]) => start < e && end > s);

  const addMatch = (match: PriceMatch) => {
    if (overlaps(match.start, match.end)) return;
    consumedRanges.push([match.start, match.end]);
    matches.push(match);
  };

  const rangeRe = /(\d[\d.]*)\s*-\s*(\d[\d.]*)\s*(?:tl|₺|try)?\s*aras[ıi]/gu;
  for (const m of text.matchAll(rangeRe)) {
    addMatch({
      start: m.index,
      end: m.index + m[0].length,
      priceMin: parseTlToKurus(m[1] ?? "0"),
      priceMax: parseTlToKurus(m[2] ?? "0"),
    });
  }

  const belowRe = /(\d[\d.]*)\s*(?:tl|₺|try)?\s*alt(?:ı|ında)/gu;
  for (const m of text.matchAll(belowRe)) {
    addMatch({
      start: m.index,
      end: m.index + m[0].length,
      priceMax: parseTlToKurus(m[1] ?? "0"),
    });
  }

  const minusPrefixRe = /-(\d[\d.]*)\s*(?:tl|₺|try)/gu;
  for (const m of text.matchAll(minusPrefixRe)) {
    addMatch({
      start: m.index,
      end: m.index + m[0].length,
      priceMax: parseTlToKurus(m[1] ?? "0"),
    });
  }

  return matches.sort((a, b) => a.start - b.start);
}
