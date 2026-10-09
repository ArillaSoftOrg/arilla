/**
 * `query_resolution` uzerinden cache-aside (docs/search.md, Kademe 2/3):
 * ayni sorgu iki kez ayristirilmaz. Kademe 3 (model) cagrisi burada YOK -
 * kademe 2 yetersizse best-effort dusuk-confidence sonuc doner, asla
 * fırlatmaz, asla model cagirmaz.
 *
 * Onbellek anahtari `query_norm` uzerinde upsert kullanilir (select-then-
 * insert degil): esazamanli ilk-kez sorgularda unique-violation yarisini
 * bastan onler.
 *
 * Gizlilik kapisi: `queryContentIneligibility`'nin reddettigi sorgu (kisisel
 * veri, kimlik benzeri rakam, sir benzeri ifade, ozel nitelikli veri, uzunluk)
 * `query_resolution`'a HIC dokunmaz - okunmaz, yazilmaz. Ayni deterministik
 * ayristirma taze yapilir; sonuc onbellekli yolla birebir aynidir.
 */
import { type Database, queryResolution } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { decideClarification } from "./clarification.ts";
import { queryContentIneligibility } from "./interpretation-eligibility.ts";
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

function toResult(row: QueryResolutionRow, cacheHit: boolean): ResolveQueryResult {
  return {
    parsed: row.parsed as QueryObject,
    parserTier: 2,
    needsClarification: row.needsClarification,
    candidateCategories: row.candidateCategories ?? null,
    cacheHit,
  };
}

/** Kademe 2: sozluk + deterministik ayristirma. Model cagrisi yok. */
async function parseFresh(db: Database, rawText: string) {
  const lexiconEntries = await loadLexicon(db);
  const parsed = parseQueryText(rawText, lexiconEntries);
  // C1 kapsaminda gercek kategori agacindan aday hesaplanmaz; bos aday
  // listesi her zaman needsClarification: false uretir. C2, ayni fonksiyona
  // zengin aday listesi vererek imzayi degistirmeden gercek hesaplamayi ekler.
  const clarification = decideClarification([]);
  return {
    parsed,
    candidateCategories:
      clarification.candidateCategoryIds.length > 0 ? clarification.candidateCategoryIds : null,
    needsClarification: clarification.needsClarification,
  };
}

export async function resolveQuery(db: Database, rawText: string): Promise<ResolveQueryResult> {
  const queryNorm = normalizeQueryText(rawText);

  if (queryContentIneligibility(queryNorm) !== null) {
    const fresh = await parseFresh(db, rawText);
    return { ...fresh, parserTier: 2, cacheHit: false };
  }

  const updated = await db
    .update(queryResolution)
    .set({ hitCount: sql`${queryResolution.hitCount} + 1`, lastUsedAt: new Date() })
    .where(eq(queryResolution.queryNorm, queryNorm))
    .returning();

  const existing = updated[0];
  if (existing) {
    return toResult(existing, true);
  }

  const fresh = await parseFresh(db, rawText);

  const inserted = await db
    .insert(queryResolution)
    .values({ queryNorm, ...fresh, parserTier: 2 })
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
