/**
 * `query_resolution` uzerinden cache-aside (docs/search.md, Kademe 2/3):
 * ayni sorgu iki kez ayristirilmaz. Kademe 3 (model) cagrisi burada YOK -
 * kademe 2 yetersizse best-effort dusuk-confidence sonuc doner, asla
 * fırlatmaz, asla model cagirmaz.
 *
 * Onbellek anahtari `query_norm` uzerinde upsert kullanilir (select-then-
 * insert degil): esazamanli ilk-kez sorgularda unique-violation yarisini
 * bastan onler.
 */
import { type Database, queryResolution } from "@arilla/db";
import { and, eq, sql } from "drizzle-orm";
import { decideClarification } from "./clarification.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { normalizeQueryText } from "./normalize.ts";
import { parseQueryText } from "./parse-query.ts";
import type { QueryObject } from "./types.ts";

export interface ResolveQueryResult {
  parsed: QueryObject;
  parserTier: 2;
  needsClarification: boolean;
  candidateCategories: number[] | null;
  cacheHit: boolean;
}

type QueryResolutionRow = typeof queryResolution.$inferSelect;

/**
 * Sozluk ayristiricisinin (`parseQueryText`, `extractPricePatterns`...) cikti
 * surumu. `parseQueryText` ciktisinin ANLAMI degisince (yeni filtre, farkli
 * tuketim) ARTIRILIR. Onbellege yazilan satirlar `parsed.parser_version` ile
 * damgalanir; daha dusuk (ya da damgasiz = 1) surumlu 2. kademe satirlar bir sonraki
 * okumada TEK SATIR olarak yeniden ayristirilir. Tablo silinmez; diger kademeler
 * (3 = model) ve baska ozellikler (`query_interpretation`, kullanici verisi)
 * etkilenmez. Surum koruma testi: `query-resolution.test.ts` (altin ozet).
 * Surumler: 1 = damgasiz (fiyat kisaltmalari oncesi), 2 = karar 0070.
 */
export const QUERY_PARSER_VERSION = 2;

/** Yalnizca 2. kademe (sozluk) satiri bayat olabilir; model kademesine dokunulmaz. */
export function isStaleResolution(row: Pick<QueryResolutionRow, "parserTier" | "parsed">): boolean {
  if (row.parserTier !== 2) return false;
  const version = (row.parsed as { parser_version?: unknown } | null)?.parser_version;
  return (typeof version === "number" ? version : 1) < QUERY_PARSER_VERSION;
}

function stamped(parsed: QueryObject): QueryObject {
  return { ...parsed, parser_version: QUERY_PARSER_VERSION };
}

function toResult(row: QueryResolutionRow, cacheHit: boolean): ResolveQueryResult {
  return {
    parsed: row.parsed as QueryObject,
    parserTier: 2,
    needsClarification: row.needsClarification,
    candidateCategories: row.candidateCategories ?? null,
    cacheHit,
  };
}

export async function resolveQuery(db: Database, rawText: string): Promise<ResolveQueryResult> {
  const queryNorm = normalizeQueryText(rawText);

  const updated = await db
    .update(queryResolution)
    .set({ hitCount: sql`${queryResolution.hitCount} + 1`, lastUsedAt: new Date() })
    .where(eq(queryResolution.queryNorm, queryNorm))
    .returning();

  const existing = updated[0];
  if (existing && !isStaleResolution(existing)) {
    return toResult(existing, true);
  }

  const lexiconEntries = await loadLexicon(db);
  const parsed = stamped(parseQueryText(rawText, lexiconEntries));

  if (existing) {
    // Eski parser surumunden kalma 2. kademe satir: yalniz bu satir yenilenir.
    const refreshed = await db
      .update(queryResolution)
      .set({ parsed, lastUsedAt: new Date() })
      .where(and(eq(queryResolution.queryNorm, queryNorm), eq(queryResolution.parserTier, 2)))
      .returning();
    const row = refreshed[0];
    if (row) return toResult(row, false);
  }
  // C1 kapsaminda gercek kategori agacindan aday hesaplanmaz; bos aday
  // listesi her zaman needsClarification: false uretir. C2, ayni fonksiyona
  // zengin aday listesi vererek imzayi degistirmeden gercek hesaplamayi ekler.
  const clarification = decideClarification([]);

  const inserted = await db
    .insert(queryResolution)
    .values({
      queryNorm,
      parsed,
      candidateCategories:
        clarification.candidateCategoryIds.length > 0 ? clarification.candidateCategoryIds : null,
      needsClarification: clarification.needsClarification,
      parserTier: 2,
    })
    .onConflictDoUpdate({
      target: queryResolution.queryNorm,
      set: { hitCount: sql`${queryResolution.hitCount} + 1`, lastUsedAt: new Date() },
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new Error("query_resolution upsert bos sonuc dondurdu");
  }
  // hitCount > 1 yalnizca coktan var olan bir satirla catisip guncelleme
  // yaptigimizda olusur (bizim insert'imiz her zaman varsayilan 1 ile
  // baslar) - bu durumda yaris kazananinin parsed degeri donulur.
  return toResult(row, row.hitCount > 1);
}
