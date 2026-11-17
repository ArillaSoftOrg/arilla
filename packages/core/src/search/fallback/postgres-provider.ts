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
    ...(query.scope === "priced" ? { candidate_scope: "priced" as const } : {}),
  };
}

/**
 * `/ara` metin aramasinda adim basina sorgu tavani (ms). Asilirsa sorgu iptal
 * edilir (57014) ve hata sinirina duser; baglanti havuzu sinirsiz tutulmaz.
 */
export const TEXT_SEARCH_TIMEOUT_MS = 5_000;

/** Fiyatli-urun geri dususunun sorgu tavani (ms); fiyatli bolum olculen ~ms'lerde biter (karar 0216). */
export const PRICED_RETRY_TIMEOUT_MS = 2_000;

function isTimeout(error: unknown): boolean {
  const code =
    (error as { code?: string; cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  return code === "57014";
}

/**
 * Adim butcesi (karar 0206): adim kendi savepoint'inde `statement_timeout = budgetMs` ile calisir.
 * Asilirsa savepoint geri alinir (dis islem saglam kalir, onceki sinir geri gelir) ve bos sayfa doner;
 * boylece yavas bir istege bagli adim (bulanik arama) isteginin tamamini oldurmez. Basarida onceki
 * sinir elle geri konur (SET LOCAL savepoint'ten sonra da surer).
 */
async function searchWithinBudget(
  db: Database,
  query: SearchQuery,
  queryObject: QueryObject,
  page: { limit: number; offset: number },
): Promise<ProviderPage> {
  const budget = String(Math.max(1, Math.floor(query.budgetMs ?? 1)));
  try {
    return await db.transaction(async (tx) => {
      const previous = await tx.execute<{ v: string }>(
        sql`SELECT current_setting('statement_timeout') AS v`,
      );
      await tx.execute(sql`SELECT set_config('statement_timeout', ${budget}, true)`);
      if (query.fuzzy) {
        await tx.execute(
          sql`SELECT set_config('pg_trgm.strict_word_similarity_threshold', ${String(FUZZY_TOKEN_THRESHOLD)}, true)`,
        );
      }
      const result = await search(tx as unknown as Database, queryObject, {
        ...page,
        ...(query.fuzzy ? { tokenThreshold: FUZZY_TOKEN_THRESHOLD } : {}),
      });
      const prior = previous.rows[0]?.v ?? "0";
      await tx.execute(sql`SELECT set_config('statement_timeout', ${prior}, true)`);
      return { items: result.items, total: result.total, totalCapped: result.totalCapped };
    });
  } catch (error) {
    if (isTimeout(error)) return { items: [], total: 0, timedOut: true };
    throw error;
  }
}

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
  async function run(
    query: SearchQuery,
    queryObject: QueryObject,
    limitMs: number | null,
  ): Promise<ProviderPage> {
    const page = { limit: query.limit, offset: query.offset };
    if (query.budgetMs !== undefined) return searchWithinBudget(db, query, queryObject, page);
    if (!query.fuzzy && limitMs === null) {
      const result = await search(db, queryObject, page);
      return { items: result.items, total: result.total, totalCapped: result.totalCapped };
    }
    // GUC'lar yalnizca bu islem icin degisir (`is_local`), havuzdaki baglanti
    // temiz doner. `<<%` indeks on filtresi `pg_trgm.strict_word_similarity_threshold`a
    // bakar; bulanik adimda dusurulur.
    return db.transaction(async (tx) => {
      if (limitMs !== null) {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(limitMs)}, true)`);
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
  }
  return {
    name: "postgres",
    async search(query: SearchQuery): Promise<ProviderPage> {
      try {
        return await run(query, toQueryObject(query), timeoutMs);
      } catch (error) {
        // Yavas exact sorgusu (3 slot, cok yaygin bas isim): hata sayfasi yerine yalniz fiyatli urunleri kisa
        // bir sinirla dene (karar 0216). Bulanik, butceli ve metinsiz sorgular kendi yolunda kalir.
        if (
          !isTimeout(error) ||
          timeoutMs === null ||
          query.fuzzy ||
          query.scope !== undefined ||
          query.slots.length === 0
        )
          throw error;
        const retry: SearchQuery = { ...query, scope: "priced" };
        const page = await run(
          retry,
          toQueryObject(retry),
          Math.min(timeoutMs, PRICED_RETRY_TIMEOUT_MS),
        );
        return { ...page, partial: true };
      }
    },
  };
}
