/**
 * Ana sayfa "Alışverişe devam et" verisi: kullanıcının kendi son metin
 * aramaları. Yeni bir geçmiş deposu YOKTUR; mevcut rızalı `search_submitted`
 * olaylarını (`recordActivity`, karar 0049) okur. Dolayısıyla:
 *
 * - yalnızca girişli kullanıcı için vardır (misafirin kalıcı geçmişi yok);
 * - analitik rızası yoksa olay hiç yazılmamıştır, liste boş döner;
 * - `query_norm` 90 günde NULL'a çekilir, NULL satırlar atlanır.
 *
 * Aynı sorgu (normalize edilmiş) tek satıra iner, en son yapılan tarih esas
 * alınır. Sıra: en yeni önce. Gösterilen metin `query_norm`'dur (Türkçe
 * karakterleri katlanmış, kayıtta ham metin tutulmaz).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

export const RECENT_SEARCHES_DEFAULT_LIMIT = 8;
export const RECENT_SEARCHES_MAX_LIMIT = 20;

export interface RecentSearch {
  queryNorm: string;
  searchedAt: Date;
}

export async function listRecentSearches(
  db: Database,
  userId: number,
  limit = RECENT_SEARCHES_DEFAULT_LIMIT,
): Promise<RecentSearch[]> {
  if (!Number.isInteger(userId)) return [];
  const take = Math.min(Math.max(Math.trunc(limit) || 0, 0), RECENT_SEARCHES_MAX_LIMIT);
  if (take === 0) return [];

  const result = await db.execute(sql`
    SELECT query_norm, MAX(created_at) AS searched_at
      FROM user_activity_event
     WHERE user_id = ${userId}
       AND kind = 'search_submitted'
       AND query_norm IS NOT NULL
     GROUP BY query_norm
     ORDER BY searched_at DESC, query_norm
     LIMIT ${take}
  `);
  return (result.rows as { query_norm: string; searched_at: Date | string }[]).map((row) => ({
    queryNorm: row.query_norm,
    searchedAt: new Date(row.searched_at),
  }));
}
