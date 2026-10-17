/**
 * `SearchProvider`in PostgreSQL gerceklemesi: mevcut `search()`i (trigram
 * metin kapisi + dengeli skor) cagirir. PostgreSQL'e ozgu her sey (SQL, GUC,
 * `strict_word_similarity`) YALNIZCA burada ve `search-sql.ts`tedir; pipeline
 * ve arayuz bunlari bilmez. OpenSearch gecisinde bu dosyanin yerine ayni
 * arayuzu uygulayan bir saglayici yazilir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { search } from "../search.ts";
import type { QueryObject } from "../types.ts";
import type { ProviderPage, SearchProvider, SearchQuery } from "./types.ts";

/**
 * Bulanik (typo) adimi icin metin kapisi esigi (varsayilan 0.5). 0.3: bitisik
 * harf yer degistirmesi ("airpdos" ~ "airpods") trigram'da 0.33 verir, 0.35
 * bunu kacirir (gercek PG'de olculdu). Dusuk esik cok aday getirir; bunlari
 * `gradeItem` (duzenleme mesafesi) eler ve adim en fazla `CANDIDATE_LIMIT` ister.
 * Daha iyi bulaniklik (fuzziness) icin asil cozum arama motorudur.
 */
export const FUZZY_TOKEN_THRESHOLD = 0.3;

function toQueryObject(query: SearchQuery): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: query.text,
    filters: query.filters,
    style_tags: [],
    sort: query.sort,
    unparsed: query.slots.map((slot) => slot[0] ?? "").join(" "),
    confidence: 1,
    text_slots: query.slots,
  };
}

/**
 * `/ara` metin aramasinda adim basina sorgu tavani (ms). Asilirsa sorgu iptal
 * edilir (57014) ve hata sinirina duser; baglanti havuzu sinirsiz tutulmaz.
 */
export const TEXT_SEARCH_TIMEOUT_MS = 5_000;

export interface PostgresSearchProviderOptions {
  /** Verilirse her adim kendi isleminde `statement_timeout` ile sinirlanir. */
  statementTimeoutMs?: number;
}

export function createPostgresSearchProvider(
  db: Database,
  options: PostgresSearchProviderOptions = {},
): SearchProvider {
  const timeoutMs =
    options.statementTimeoutMs === undefined
      ? null
      : Math.max(1, Math.floor(options.statementTimeoutMs));
  return {
    name: "postgres",
    async search(query: SearchQuery): Promise<ProviderPage> {
      const queryObject = toQueryObject(query);
      const page = { limit: query.limit, offset: query.offset };
      if (!query.fuzzy && timeoutMs === null) {
        const result = await search(db, queryObject, page);
        return { items: result.items, total: result.total, totalCapped: result.totalCapped };
      }
      // GUC'lar yalnizca bu islem icin degisir (`is_local`), havuzdaki baglanti
      // temiz doner. `<<%` indeks on filtresi `pg_trgm.strict_word_similarity_threshold`a
      // bakar; bulanik adimda dusurulur.
      return db.transaction(async (tx) => {
        if (timeoutMs !== null) {
          await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`);
        }
        if (!query.fuzzy) {
          const result = await search(tx as unknown as Database, queryObject, page);
          return { items: result.items, total: result.total, totalCapped: result.totalCapped };
        }
        await tx.execute(
          sql`SELECT set_config('pg_trgm.strict_word_similarity_threshold', ${String(FUZZY_TOKEN_THRESHOLD)}, true)`,
        );
        const result = await search(tx as unknown as Database, queryObject, {
          ...page,
          tokenThreshold: FUZZY_TOKEN_THRESHOLD,
        });
        return { items: result.items, total: result.total, totalCapped: result.totalCapped };
      });
    },
  };
}
