/**
 * Kademe 2: sozluk tabanli ayristirma (docs/search.md). Saf fonksiyon - DB,
 * ag, model cagrisi yok. `lexiconEntries` disaridan enjekte edilir: testte
 * elle yazilir, uretimde `loadLexicon(db)`'den gelir.
 */
import { findLexiconMatches, type LexiconEntry } from "./lexicon.ts";
import {
  normalizeQueryText,
  normalizeSizeToken,
  type Token,
  tokenizeWithOffsets,
} from "./normalize.ts";
import { extractPricePatterns } from "./price-patterns.ts";
import { buildTextSlots } from "./text-match.ts";
import type { QueryFilters, QueryObject } from "./types.ts";

export interface ParseQueryOptions {
  /**
   * Dusuk guven esigi: geneldeki tek/zayif bir esleme (orn. uzun, alakasiz
   * bir cumlede tek basina gecen bir kategori terimi) bu esigin altinda
   * kalirsa `category_path` atanmaz - gurultuyu belirleyici filtre haline
   * getirmemek icin. Diger filtreler (renk, fiyat, beden, marka) bu esikten
   * etkilenmez, cunku onlar zaten kendi ac k desenleriyle (regex/tam sozluk
   * eslesmesi) dogrulanir.
   */
  minConfidence?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.35;

const SIZE_NUMARA_RE = /(\d+)\s*numara/gu;
const SIZE_BEDEN_RE = /(\p{L}+)\s*beden/gu;

const BRAND_EXCLUDE_MARKERS = [
  "olmasın",
  "olmasin",
  "hariç",
  "haric",
  "değil",
  "degil",
  "dışında",
  "disinda",
];
const BRAND_SKIP_MARKERS = ["tarzı", "tarzi", "gibi"];
const BRAND_CONTEXT_WINDOW = 16;

interface Span {
  start: number;
  end: number;
}

function overlapsAny(span: Span, spans: readonly Span[]): boolean {
  return spans.some((s) => span.start < s.end && span.end > s.start);
}

function markTokensConsumed(tokens: readonly Token[], consumed: boolean[], span: Span): void {
  tokens.forEach((token, i) => {
    if (token.start < span.end && token.end > span.start) {
      consumed[i] = true;
    }
  });
}

export function parseQueryText(
  text: string,
  lexiconEntries: readonly LexiconEntry[],
  options: ParseQueryOptions = {},
): QueryObject {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const normalized = normalizeQueryText(text);
  const tokens = tokenizeWithOffsets(normalized);
  const consumed = new Array<boolean>(tokens.length).fill(false);
  const consumedSpans: Span[] = [];

  const filters: QueryFilters = {};
  const colors = new Set<string>();
  const brandInclude = new Set<string>();
  const brandExclude = new Set<string>();
  let bestCategory: { normalized: string; weight: number } | undefined;

  for (const match of extractPricePatterns(normalized)) {
    const span: Span = { start: match.start, end: match.end };
    if (overlapsAny(span, consumedSpans)) continue;
    consumedSpans.push(span);
    markTokensConsumed(tokens, consumed, span);
    if (match.priceMin !== undefined) filters.price_min = match.priceMin;
    if (match.priceMax !== undefined) filters.price_max = match.priceMax;
  }

  for (const m of normalized.matchAll(SIZE_NUMARA_RE)) {
    const span: Span = { start: m.index, end: m.index + m[0].length };
    if (overlapsAny(span, consumedSpans) || filters.size_norm !== undefined) continue;
    consumedSpans.push(span);
    markTokensConsumed(tokens, consumed, span);
    filters.size_norm = normalizeSizeToken(m[1] ?? "");
  }

  for (const m of normalized.matchAll(SIZE_BEDEN_RE)) {
    const span: Span = { start: m.index, end: m.index + m[0].length };
    if (overlapsAny(span, consumedSpans) || filters.size_norm !== undefined) continue;
    consumedSpans.push(span);
    markTokensConsumed(tokens, consumed, span);
    filters.size_norm = normalizeSizeToken(m[1] ?? "");
  }

  // En uzun sozluk eslesmesi once - kisa bir alt-dize (orn. "ayakkabı") daha
  // uzun bir kalibi (orn. "spor ayakkabı") boldugunde uzun olan kazanir.
  const lexiconMatches = findLexiconMatches(normalized, lexiconEntries).sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  );

  for (const match of lexiconMatches) {
    const span: Span = { start: match.start, end: match.end };
    if (overlapsAny(span, consumedSpans)) continue;

    if (match.entry.kind === "color") {
      consumedSpans.push(span);
      markTokensConsumed(tokens, consumed, span);
      colors.add(match.entry.normalized);
      continue;
    }

    if (match.entry.kind === "category") {
      consumedSpans.push(span);
      markTokensConsumed(tokens, consumed, span);
      if (bestCategory === undefined || match.entry.weight > bestCategory.weight) {
        bestCategory = { normalized: match.entry.normalized, weight: match.entry.weight };
      }
      continue;
    }

    if (match.entry.kind === "brand") {
      const windowEnd = Math.min(normalized.length, span.end + BRAND_CONTEXT_WINDOW);
      const after = normalized.slice(span.end, windowEnd);

      if (BRAND_SKIP_MARKERS.some((marker) => after.includes(marker))) {
        // "nike tarzı" gibi betimleyici kullanim bir filtre talebi degildir;
        // esleme yapilmaz, kelime unparsed'a dusmeye devam eder.
        continue;
      }

      consumedSpans.push(span);
      markTokensConsumed(tokens, consumed, span);

      const excludeMarker = BRAND_EXCLUDE_MARKERS.find((marker) => after.includes(marker));
      if (excludeMarker !== undefined) {
        brandExclude.add(match.entry.normalized);
        const markerStart = span.end + after.indexOf(excludeMarker);
        const markerSpan: Span = { start: markerStart, end: markerStart + excludeMarker.length };
        consumedSpans.push(markerSpan);
        markTokensConsumed(tokens, consumed, markerSpan);
      } else {
        brandInclude.add(match.entry.normalized);
      }
    }
  }

  const consumedCount = consumed.filter(Boolean).length;
  const confidence = tokens.length === 0 ? 0 : consumedCount / tokens.length;

  if (colors.size > 0) filters.color = [...colors];
  if (bestCategory !== undefined && confidence >= minConfidence) {
    filters.category_path = bestCategory.normalized;
  }
  if (brandInclude.size > 0) filters.brand_include = [...brandInclude];
  if (brandExclude.size > 0) filters.brand_exclude = [...brandExclude];

  const unparsed = tokens
    .filter((_, i) => !consumed[i])
    .map((token) => token.value)
    .join(" ");

  return {
    intent: "browse",
    anchor: null,
    text,
    filters,
    style_tags: [],
    sort: "balanced",
    unparsed,
    confidence,
    text_slots: buildTextSlots(unparsed, lexiconEntries),
  };
}
