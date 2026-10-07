/**
 * `SearchIntent` -> mevcut arama (docs/decisions/0074). Ince uyarlayici: ikinci
 * bir arama motoru, sira ya da skor YOK.
 *
 *   SearchIntent -> metin + kisitlar -> `parseQueryText` (mevcut sozluk) -> QueryObject
 *                -> `searchWithFallback` (mevcut asamali arama) -> gercek urunler
 *
 * Model kategori/marka/renk icin serbest metin verir; bunlari katalog kimligine
 * ceviren, katalogda olmayani eleyen mevcut sozluktur. Fiyat dogrudan kurusa
 * cevrilir (CLAUDE.md: tamsayi kurus). Istek yolunda model cagrisi YOK.
 */
import type { Database } from "@arilla/db";
import {
  createPostgresSearchProvider,
  createSeedAliasSource,
  type FallbackSearchOutcome,
  searchWithFallback,
} from "../search/fallback/index.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { loadLexicon } from "../search/lexicon-repository.ts";
import { foldTurkish } from "../search/normalize.ts";
import { parseQueryText } from "../search/parse-query.ts";
import type { QueryObject, SortMode } from "../search/types.ts";
import type { SearchIntent } from "./contract.ts";

/** Sohbet sonuc blogundaki urun sayisi; tam liste `/ara` baglantisindadir. */
export const CHAT_RESULT_LIMIT = 8;

function containsWord(haystack: string, needle: string): boolean {
  return foldTurkish(haystack).includes(foldTurkish(needle));
}

/** Sozluk ayristiricisina verilen tek metin: niyetin metinsel kisitlari. */
export function intentSearchText(intent: SearchIntent): string {
  const parts = [intent.query];
  const add = (value: string | null) => {
    if (value && !containsWord(parts.join(" "), value)) parts.push(value);
  };
  add(intent.brand);
  for (const color of intent.colors) add(color);
  // Marka dislama: ayristiricinin mevcut "olmasin" kalibi.
  for (const brand of intent.excludeBrands) parts.push(`${brand} olmasın`);
  return parts.join(" ");
}

export function intentSortMode(intent: SearchIntent): SortMode {
  return intent.sort === "cheapest" ? "best_deal" : "balanced";
}

/**
 * Saf: sozluk disaridan gelir. Kategori yalnizca metinden cikmadiysa ve sozlukte
 * karsiligi varsa eklenir; karsiligi yoksa gurultu filtreye cevrilmez.
 */
export function intentToQueryObject(
  intent: SearchIntent,
  lexicon: readonly LexiconEntry[],
): QueryObject {
  const parsed = parseQueryText(intentSearchText(intent), lexicon);
  const filters = { ...parsed.filters };

  if (filters.category_path === undefined && intent.category) {
    const categoryPath = parseQueryText(intent.category, lexicon).filters.category_path;
    if (categoryPath !== undefined) filters.category_path = categoryPath;
  }
  if (intent.priceMin !== null) filters.price_min = intent.priceMin * 100;
  if (intent.priceMax !== null) filters.price_max = intent.priceMax * 100;
  if (intent.size && filters.size_norm === undefined) {
    filters.size_norm = foldTurkish(intent.size).trim().replace(/\s+/g, "-");
  }
  return { ...parsed, filters, sort: intentSortMode(intent) };
}

export interface IntentSearchOptions {
  page?: number;
  pageSize?: number;
  lexicon?: readonly LexiconEntry[];
}

/** Niyeti mevcut aramada calistirir. Hata firlatabilir; sayfa kendi sinirinda yakalar. */
export async function searchByIntent(
  db: Database,
  intent: SearchIntent,
  options: IntentSearchOptions = {},
): Promise<FallbackSearchOutcome> {
  const lexicon = options.lexicon ?? (await loadLexicon(db));
  const parsed = intentToQueryObject(intent, lexicon);
  return searchWithFallback(
    createPostgresSearchProvider(db),
    {
      parsed,
      sort: parsed.sort,
      page: options.page ?? 1,
      pageSize: options.pageSize ?? CHAT_RESULT_LIMIT,
    },
    { aliases: createSeedAliasSource() },
  );
}
