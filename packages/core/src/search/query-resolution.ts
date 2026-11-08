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
 * Surum (docs/decisions/0171 §6.4): her satir, ureten ayristirici surumu ve
 * sozluk ozetiyle damgalanir (`parsed._resolver`). Damgasi bugunku surumle
 * uyusmayan satir okunmaz; ayni istek icinde yeniden ayristirilip guncellenir.
 * Boylece ayristirici kodu degisince ya da sozluge yonetim paneli disindan
 * yazilinca eski ayristirma tasinmaz (panel disi yazim, surec ici sozluk
 * onbellegi omru kadar - en cok `LEXICON_CACHE_TTL_MS` - gecikmeyle
 * gorunur; panel yazimi zaten onbellegi temizler). Damgasiz (eski) satirlar bir kez
 * yeniden ayristirilir; deterministik oldugu icin sonuc ayni sozlukle aynidir.
 *
 * Gizlilik kapisi: `queryContentIneligibility`'nin reddettigi sorgu (kisisel
 * veri, kimlik benzeri rakam, sir benzeri ifade, ozel nitelikli veri, uzunluk)
 * `query_resolution`'a HIC dokunmaz - okunmaz, yazilmaz. Ayni deterministik
 * ayristirma taze yapilir; sonuc onbellekli yolla birebir aynidir.
 */
import { createHash } from "node:crypto";
import { type Database, queryResolution } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { decideClarification } from "./clarification.ts";
import { queryContentIneligibility } from "./interpretation-eligibility.ts";
import type { LexiconEntry } from "./lexicon.ts";
import { invalidateLexiconCache, loadLexiconCached } from "./lexicon-cache.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { normalizeQueryText } from "./normalize.ts";
import { parseQueryText } from "./parse-query.ts";
import type { QueryObject } from "./types.ts";

/**
 * Ayristirma kodunun surumu. `parse-query.ts`, fiyat dili ya da netlestirme
 * karari degisip AYNI sorgu farkli ayristirilacaksa ARTIRILIR.
 */
// 2: olumsuz nitelik zorunlu metinden cikar (karar 0176 Faz 2).
export const RESOLVER_VERSION = "2";

/** `parsed` icinde saklanan surum damgasi; okurken disari verilmez. */
const VERSION_KEY = "_resolver";

const fingerprints = new WeakMap<readonly LexiconEntry[], string>();

/** Sozluk icerigi ozeti (sira bagimsiz). Ayni dizi icin bir kez hesaplanir. */
export function lexiconFingerprint(entries: readonly LexiconEntry[]): string {
  const cached = fingerprints.get(entries);
  if (cached !== undefined) return cached;
  const canonical = entries
    .map((e) => `${e.kind}\u0000${e.surface}\u0000${e.normalized}\u0000${e.weight}`)
    .sort()
    .join("\u0001");
  const value = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
  fingerprints.set(entries, value);
  return value;
}

export function resolverVersion(entries: readonly LexiconEntry[]): string {
  return `${RESOLVER_VERSION}:${lexiconFingerprint(entries)}`;
}

export interface ResolveQueryResult {
  parsed: QueryObject;
  parserTier: 2;
  needsClarification: boolean;
  candidateCategories: number[] | null;
  cacheHit: boolean;
}

type QueryResolutionRow = typeof queryResolution.$inferSelect;

function storedVersion(row: QueryResolutionRow): string | null {
  const parsed = row.parsed as Record<string, unknown> | null;
  const value = parsed?.[VERSION_KEY];
  return typeof value === "string" ? value : null;
}

function toResult(row: QueryResolutionRow, cacheHit: boolean): ResolveQueryResult {
  const { [VERSION_KEY]: _version, ...parsed } = row.parsed as Record<string, unknown>;
  return {
    parsed: parsed as unknown as QueryObject,
    parserTier: 2,
    needsClarification: row.needsClarification,
    candidateCategories: row.candidateCategories ?? null,
    cacheHit,
  };
}

/**
 * Satirin tazeligi. Bayatsa, karsilastirma icin tazeden okunan sozluk (varsa)
 * geri verilir; yeniden ayristirma ayni sozlugu kullanir, ikinci okuma yapilmaz.
 */
type Freshness = { current: true } | { current: false; lexicon: LexiconEntry[] | null };

/** Damganin kod surumu kismi ("1:abcd..." -> "1"). */
function codeVersionOf(stamp: string): string {
  return stamp.slice(0, stamp.indexOf(":"));
}

/**
 * Satir bugunku ayristirici + sozlukle mi uretildi? Surec ici sozluk onbellegi
 * (en cok 5 dk) bayat olabilir: uyusmazlikta sozluk tazeden okunur ve tekrar
 * karsilastirilir; yalnizca gercekten bayat satir yeniden ayristirilir.
 *
 * Sozluk okunamazsa (DB hatasi): damgasi BUGUNKU kod surumune ait satir
 * sunulur - #267 oncesi davranis, isabet yolu sozluge hic bagli degildi;
 * sozluk ozeti dogrulanamaz ama arama kesilmez. Damgasiz ya da baska kod
 * surumune ait satir sunulmaz: yeniden ayristirma sozluk ister, hata yukari
 * iletilir (kayit-yok yolunun bugunku davranisi).
 */
async function checkRow(db: Database, row: QueryResolutionRow): Promise<Freshness> {
  const stored = storedVersion(row);
  if (stored === null) return { current: false, lexicon: null };
  const sameCode = codeVersionOf(stored) === RESOLVER_VERSION;
  let fresh: LexiconEntry[];
  try {
    if (stored === resolverVersion(await loadLexiconCached(db))) return { current: true };
    fresh = await loadLexicon(db);
  } catch (error) {
    if (sameCode) {
      // Sorgu metni loga girmez (kisisel veri).
      console.warn("[query_resolution] sozluk okunamadi; damgali satir sunuldu", {
        code: (error as { code?: string } | null)?.code ?? "unknown",
      });
      return { current: true };
    }
    throw error;
  }
  if (stored === resolverVersion(fresh)) {
    // Bu surecin sozluk onbellegi geride kalmis: tazelet.
    invalidateLexiconCache(db);
    return { current: true };
  }
  return { current: false, lexicon: fresh };
}

/** Kademe 2: sozluk + deterministik ayristirma. Model cagrisi yok. */
async function parseFresh(db: Database, rawText: string, lexicon: LexiconEntry[] | null = null) {
  const lexiconEntries = lexicon ?? (await loadLexicon(db));
  const parsed = parseQueryText(rawText, lexiconEntries);
  // C1 kapsaminda gercek kategori agacindan aday hesaplanmaz; bos aday
  // listesi her zaman needsClarification: false uretir. C2, ayni fonksiyona
  // zengin aday listesi vererek imzayi degistirmeden gercek hesaplamayi ekler.
  const clarification = decideClarification([]);
  return {
    parsed,
    version: resolverVersion(lexiconEntries),
    candidateCategories:
      clarification.candidateCategoryIds.length > 0 ? clarification.candidateCategoryIds : null,
    needsClarification: clarification.needsClarification,
  };
}

function freshResult(fresh: Awaited<ReturnType<typeof parseFresh>>): ResolveQueryResult {
  return {
    parsed: fresh.parsed,
    parserTier: 2,
    needsClarification: fresh.needsClarification,
    candidateCategories: fresh.candidateCategories,
    cacheHit: false,
  };
}

/**
 * `resolveQuery` ile ayni sonuc, HICBIR YAZIM olmadan (salt okunur olcum araci,
 * `scripts/search-probe.ts`): onbellekte guncel satir varsa okunur (sayac
 * artmaz), yoksa ayni deterministik ayristirma calisir ve sonuc saklanmaz.
 */
export async function peekQuery(db: Database, rawText: string): Promise<ResolveQueryResult> {
  const queryNorm = normalizeQueryText(rawText);
  if (queryContentIneligibility(queryNorm) === null) {
    const rows = await db
      .select()
      .from(queryResolution)
      .where(eq(queryResolution.queryNorm, queryNorm))
      .limit(1);
    if (rows[0]) {
      const freshness = await checkRow(db, rows[0]);
      if (freshness.current) return toResult(rows[0], true);
      return freshResult(await parseFresh(db, rawText, freshness.lexicon));
    }
  }
  return freshResult(await parseFresh(db, rawText));
}

export async function resolveQuery(db: Database, rawText: string): Promise<ResolveQueryResult> {
  const queryNorm = normalizeQueryText(rawText);

  if (queryContentIneligibility(queryNorm) !== null) {
    return freshResult(await parseFresh(db, rawText));
  }

  const updated = await db
    .update(queryResolution)
    .set({ hitCount: sql`${queryResolution.hitCount} + 1`, lastUsedAt: new Date() })
    .where(eq(queryResolution.queryNorm, queryNorm))
    .returning();

  const existing = updated[0];
  if (existing) {
    const freshness = await checkRow(db, existing);
    if (freshness.current) return toResult(existing, true);
    // Bayat satir: yeniden ayristir (karsilastirmada okunan sozlukle) ve yerinde
    // guncelle (sayac korunur).
    const fresh = await parseFresh(db, rawText, freshness.lexicon);
    await db
      .update(queryResolution)
      .set({
        parsed: stamp(fresh.parsed, fresh.version),
        candidateCategories: fresh.candidateCategories,
        needsClarification: fresh.needsClarification,
        parserTier: 2,
      })
      .where(eq(queryResolution.queryNorm, queryNorm));
    return freshResult(fresh);
  }

  const fresh = await parseFresh(db, rawText);

  const inserted = await db
    .insert(queryResolution)
    .values({
      queryNorm,
      parsed: stamp(fresh.parsed, fresh.version),
      candidateCategories: fresh.candidateCategories,
      needsClarification: fresh.needsClarification,
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

function stamp(parsed: QueryObject, version: string): Record<string, unknown> {
  return { ...parsed, [VERSION_KEY]: version };
}
