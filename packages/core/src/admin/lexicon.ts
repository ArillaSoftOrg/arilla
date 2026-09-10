/**
 * `/yonetim/sozluk` (docs/pages.md): `lexicon` tablosunun tablo görünümü,
 * satır içi düzenleme, tür filtresi, arama; ekranın üstünde son 7 günde
 * kademe 3'e düşen sorgular.
 */
import { and, desc, eq, gte, ilike, or } from "drizzle-orm";
import { type Database, lexicon, queryResolution } from "@arilla/db";
import type { LexiconKind } from "../search/lexicon.ts";

export interface LexiconFilter {
  kind?: LexiconKind;
  search?: string;
}

export async function listLexicon(db: Database, filter: LexiconFilter = {}) {
  const conditions = [];
  if (filter.kind) conditions.push(eq(lexicon.kind, filter.kind));
  if (filter.search) {
    const term = `%${filter.search}%`;
    conditions.push(or(ilike(lexicon.surface, term), ilike(lexicon.normalized, term)));
  }
  return db
    .select()
    .from(lexicon)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(lexicon.kind, lexicon.surface);
}

export interface UpsertLexiconInput {
  /** Verilirse güncelleme, verilmezse ekleme (kind+surface çakışırsa yine güncelleme). */
  id?: number;
  kind: LexiconKind;
  surface: string;
  normalized: string;
  weight?: number;
}

/**
 * Ekle/düzenle. `query_resolution` önbelleği bu işlemde tamamen temizlenir:
 * aksi halde daha önce görülmüş bir sorgu, yeni sözlük satırına rağmen eski
 * ayrıştırmayı döndürmeye devam eder ve pages.md'nin "aramayı anında
 * etkiliyor" kabul kriteri tekrar eden sorgular için tutmazdı
 * (`resolveQuery`, `packages/core/src/search/query-resolution.ts`, bir
 * `query_norm`'u kalıcı olarak önbelleğe alır).
 */
export async function upsertLexiconEntry(db: Database, input: UpsertLexiconInput): Promise<void> {
  const weight = input.weight ?? 1.0;
  await db.transaction(async (tx) => {
    if (input.id !== undefined) {
      await tx
        .update(lexicon)
        .set({ kind: input.kind, surface: input.surface, normalized: input.normalized, weight })
        .where(eq(lexicon.id, input.id));
    } else {
      await tx
        .insert(lexicon)
        .values({ kind: input.kind, surface: input.surface, normalized: input.normalized, weight })
        .onConflictDoUpdate({
          target: [lexicon.kind, lexicon.surface],
          set: { normalized: input.normalized, weight },
        });
    }
    await tx.delete(queryResolution);
  });
}

export interface Tier3Query {
  queryNorm: string;
  hitCount: number;
  lastUsedAt: Date;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * pages.md: "son 7 günde kademe 3'e düşen sorguların listesi... sözlüğe
 * eklenecek adaylar oradan seçilir." Kademe 3 (model) henüz yazılmadı — C1
 * yalnızca kademe 2 üretiyor (`packages/core/src/search/query-resolution.ts`)
 * — o iş bitene kadar bu liste her zaman boş döner.
 */
export async function recentTier3Queries(db: Database, limit = 20): Promise<Tier3Query[]> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  return db
    .select({
      queryNorm: queryResolution.queryNorm,
      hitCount: queryResolution.hitCount,
      lastUsedAt: queryResolution.lastUsedAt,
    })
    .from(queryResolution)
    .where(and(eq(queryResolution.parserTier, 3), gte(queryResolution.lastUsedAt, since)))
    .orderBy(desc(queryResolution.hitCount))
    .limit(limit);
}
