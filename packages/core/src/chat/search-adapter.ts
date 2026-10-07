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
import { sql } from "drizzle-orm";
import {
  createPostgresSearchProvider,
  createSeedAliasSource,
  type FallbackSearchOutcome,
  type Relaxation,
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

/** Aramada kullanicinin istedigi ama uygulanamayan kisit (arayuz acikca soyler). */
export interface IntentNote {
  kind: "brand_exclude_unresolved";
  value: string;
}

function excludeResolves(brand: string, lexicon: readonly LexiconEntry[]): boolean {
  const parsed = parseQueryText(`${brand} olmasın`, lexicon);
  return (parsed.filters.brand_exclude?.length ?? 0) > 0;
}

/** Sozluk ayristiricisina verilen tek metin: niyetin metinsel kisitlari. */
export function intentSearchText(intent: SearchIntent, lexicon?: readonly LexiconEntry[]): string {
  const parts = [intent.query];
  const add = (value: string | null) => {
    if (value && !containsWord(parts.join(" "), value)) parts.push(value);
  };
  add(intent.brand);
  for (const color of intent.colors) add(color);
  // Marka dislama: ayristiricinin mevcut "olmasin" kalibi. Sozlukte karsiligi olmayan
  // marka metne EKLENMEZ: yoksa "olmasin" denen marka kapiya zorunlu terim olurdu.
  for (const brand of intent.excludeBrands) {
    if (lexicon === undefined || excludeResolves(brand, lexicon)) parts.push(`${brand} olmasın`);
  }
  return parts.join(" ");
}

export function intentNotes(intent: SearchIntent, lexicon: readonly LexiconEntry[]): IntentNote[] {
  return intent.excludeBrands
    .filter((brand) => !excludeResolves(brand, lexicon))
    .map((value) => ({ kind: "brand_exclude_unresolved" as const, value }));
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
  const parsed = parseQueryText(intentSearchText(intent, lexicon), lexicon);
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
  /** Arama sorgusunun ust siniri (SET LOCAL statement_timeout); asilinca `IntentSearchTimeoutError`. */
  timeoutMs?: number;
}

export const INTENT_SEARCH_TIMEOUT_MS = 4_000;

export class IntentSearchTimeoutError extends Error {
  constructor() {
    super("intent search timed out");
    this.name = "IntentSearchTimeoutError";
  }
}

export interface IntentSearchResult {
  outcome: FallbackSearchOutcome;
  /** Gorunen urunlerden fiyat kisitini ihlal edenler elendi mi (kart fiyati != filtre fiyati). */
  droppedForPrice: number;
  notes: IntentNote[];
  /** Arama kisit gevsetti mi (renk, beden, kategori, sozcuk...): arayuz sessizce gizlemez. */
  relaxed: Relaxation[];
}

function withinPrice(price: number | null, intent: SearchIntent): boolean {
  if (price === null) return true;
  if (intent.priceMin !== null && price < intent.priceMin * 100) return false;
  if (intent.priceMax !== null && price > intent.priceMax * 100) return false;
  return true;
}

function isTimeout(error: unknown): boolean {
  const code =
    (error as { code?: string; cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  return code === "57014";
}

/**
 * Niyeti mevcut aramada calistirir. Sorgu kendi islemi icinde `statement_timeout`
 * ile sinirlidir (baglanti sinirsiz tutulmaz). Kart fiyati (secilen teklif) ile filtre
 * fiyati (`product.min_price`) ayrisabilir: kullanici "2500 TL altı" dediyse ustunde
 * gorunen kart gosterilmez.
 */
export async function searchByIntent(
  db: Database,
  intent: SearchIntent,
  options: IntentSearchOptions = {},
): Promise<IntentSearchResult> {
  const lexicon = options.lexicon ?? (await loadLexicon(db));
  const parsed = intentToQueryObject(intent, lexicon);
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? INTENT_SEARCH_TIMEOUT_MS));
  let outcome: FallbackSearchOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`);
      return searchWithFallback(
        createPostgresSearchProvider(tx as unknown as Database),
        {
          parsed,
          sort: parsed.sort,
          page: options.page ?? 1,
          pageSize: options.pageSize ?? CHAT_RESULT_LIMIT,
        },
        { aliases: createSeedAliasSource() },
      );
    });
  } catch (error) {
    if (isTimeout(error)) throw new IntentSearchTimeoutError();
    throw error;
  }

  const kept = outcome.items.filter((item) => withinPrice(item.minPrice, intent));
  const droppedForPrice = outcome.items.length - kept.length;
  const relaxed = new Set<Relaxation>(outcome.trace.relaxed);
  if (outcome.mode !== "results")
    for (const item of outcome.items) for (const r of item.match.relaxed) relaxed.add(r);
  return {
    outcome: droppedForPrice === 0 ? outcome : { ...outcome, items: kept },
    droppedForPrice,
    notes: intentNotes(intent, lexicon),
    relaxed: [...relaxed],
  };
}
