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

/** Bulanik (typo) adimi icin metin kapisi esigi (varsayilan 0.5). */
export const FUZZY_TOKEN_THRESHOLD = 0.35;

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

export function createPostgresSearchProvider(db: Database): SearchProvider {
  return {
    name: "postgres",
    async search(query: SearchQuery): Promise<ProviderPage> {
      const queryObject = toQueryObject(query);
      const page = { limit: query.limit, offset: query.offset };
      if (!query.fuzzy) {
        const result = await search(db, queryObject, page);
        return { items: result.items, total: result.total };
      }
      // `<<%` indeks on filtresi `pg_trgm.strict_word_similarity_threshold`a
      // bakar; yalnizca bu islem icin dusurulur (`is_local`), havuzdaki baglanti
      // temiz doner.
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('pg_trgm.strict_word_similarity_threshold', ${String(FUZZY_TOKEN_THRESHOLD)}, true)`,
        );
        const result = await search(tx as unknown as Database, queryObject, {
          ...page,
          tokenThreshold: FUZZY_TOKEN_THRESHOLD,
        });
        return { items: result.items, total: result.total };
      });
    },
  };
}
