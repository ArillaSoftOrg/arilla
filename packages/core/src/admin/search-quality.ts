/**
 * Sorunlu sorgular (`/yonetim/sozluk`, karar 0054): `search_query_day`
 * günlük özetinden son 7/30 günün sonuçsuz, yedek listeye düşen, tanınmayan
 * kelimeli ve sık sorguları. Salt okunur, zaman aşımlı, sayfalı.
 *
 * Yetenek `diagnostics.read`: veri arama davranışı gözlemidir (arama
 * tanısıyla aynı sınıf). Sözlüğü düzenleyebilmek (`dictionary.write`)
 * kendiliğinden kullanıcı sorgularını okuma yetkisi vermez; sözlük sayfası
 * bölümü yalnızca izleyici bu yeteneğe de sahipse gösterir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { SEARCH_QUALITY_TIME_ZONE } from "../search/quality.ts";
import { clampPage, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const SEARCH_QUALITY_WINDOWS = [7, 30] as const;
export type SearchQualityWindow = (typeof SEARCH_QUALITY_WINDOWS)[number];

export const SEARCH_QUALITY_KINDS = ["zero", "fallback", "unrecognized", "frequent"] as const;
export type SearchQualityKind = (typeof SEARCH_QUALITY_KINDS)[number];

export const SEARCH_QUALITY_PAGE_SIZE = 25;
const TERM_LIMIT = 30;

export function isSearchQualityWindow(value: unknown): value is SearchQualityWindow {
  return (SEARCH_QUALITY_WINDOWS as readonly unknown[]).includes(value);
}

export function isSearchQualityKind(value: unknown): value is SearchQualityKind {
  return typeof value === "string" && (SEARCH_QUALITY_KINDS as readonly string[]).includes(value);
}

export interface SearchQualityQueryRow {
  queryNorm: string;
  searches: number;
  zeroResults: number;
  fallbacks: number;
  clarifications: number;
  lastResultCount: number | null;
  /** Tanınmayan kelimeler: kelimesi olan en son günün listesi. */
  unrecognizedTerms: string[];
  lastSeenAt: Date;
}

export interface SearchQualityListing {
  days: SearchQualityWindow;
  kind: SearchQualityKind;
  page: number;
  rows: SearchQualityQueryRow[];
  hasNext: boolean;
  totals: { searches: number; zeroResults: number; fallbacks: number; queries: number };
  terms: { term: string; searches: number; queries: number }[];
}

/** Sıralama ve süzgeç allowlist'i: kullanıcı girdisi SQL'e yalnızca bu eşleme üzerinden girer. */
const KIND_SQL = {
  zero: {
    having: sql`sum(zero_results) > 0`,
    order: sql`sum(zero_results) DESC`,
    pageOrder: sql`page.zero_results DESC`,
  },
  fallback: {
    having: sql`sum(fallbacks) > 0`,
    order: sql`sum(fallbacks) DESC`,
    pageOrder: sql`page.fallbacks DESC`,
  },
  unrecognized: {
    having: sql`bool_or(cardinality(unrecognized_terms) > 0)`,
    order: sql`sum(searches) DESC`,
    pageOrder: sql`page.searches DESC`,
  },
  frequent: {
    having: sql`TRUE`,
    order: sql`sum(searches) DESC`,
    pageOrder: sql`page.searches DESC`,
  },
} as const;

type Row = Record<string, unknown>;

export async function listSearchQualityQueries(
  db: Database,
  actor: AdminActor,
  options: { days?: unknown; kind?: unknown; page?: unknown } = {},
  now: Date = new Date(),
): Promise<SearchQualityListing> {
  assertCapability(actor, "diagnostics.read");
  const days: SearchQualityWindow = isSearchQualityWindow(options.days) ? options.days : 7;
  const kind: SearchQualityKind = isSearchQualityKind(options.kind) ? options.kind : "zero";
  const page = clampPage(options.page);
  const offset = (page - 1) * SEARCH_QUALITY_PAGE_SIZE;
  const at = now.toISOString();
  // Bugün dahil son `days` takvim günü (Europe/Istanbul).
  const since = sql`((${at}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date - ${days - 1}::int)`;
  const spec = KIND_SQL[kind];

  return readOnly(db, 5_000, async (tx) => {
    // Toplama önce, sayfa sonra. Kelime listesi `array_agg` ile alınamaz
    // (dizi dizisi 2 boyutlu olur, `[1]` NULL döner): kelimesi olan en son
    // gün seçilir ve satır PK (day, query_norm) ile tam eşleşmeyle okunur.
    const list = await tx.execute<Row>(sql`
      WITH page AS (
        SELECT query_norm,
               sum(searches)::int AS searches,
               sum(zero_results)::int AS zero_results,
               sum(fallbacks)::int AS fallbacks,
               sum(clarifications)::int AS clarifications,
               (array_agg(last_result_count ORDER BY day DESC))[1] AS last_result_count,
               (array_agg(day ORDER BY day DESC)
                  FILTER (WHERE cardinality(unrecognized_terms) > 0))[1] AS terms_day,
               max(last_seen_at) AS last_seen_at
        FROM search_query_day
        WHERE day >= ${since}
        GROUP BY query_norm
        HAVING ${spec.having}
        ORDER BY ${spec.order}, sum(searches) DESC, query_norm ASC
        LIMIT ${SEARCH_QUALITY_PAGE_SIZE + 1} OFFSET ${offset}
      )
      SELECT page.*, COALESCE(d.unrecognized_terms, '{}') AS unrecognized_terms
      FROM page
      LEFT JOIN search_query_day d ON d.day = page.terms_day AND d.query_norm = page.query_norm
      ORDER BY ${spec.pageOrder}, page.searches DESC, page.query_norm ASC
    `);
    const totals = await tx.execute<Row>(sql`
      SELECT COALESCE(sum(searches), 0)::int AS searches,
             COALESCE(sum(zero_results), 0)::int AS zero_results,
             COALESCE(sum(fallbacks), 0)::int AS fallbacks,
             count(DISTINCT query_norm)::int AS queries
      FROM search_query_day
      WHERE day >= ${since}
    `);
    const terms = await tx.execute<Row>(sql`
      SELECT t.term, sum(d.searches)::int AS searches, count(DISTINCT d.query_norm)::int AS queries
      FROM search_query_day d, unnest(d.unrecognized_terms) AS t(term)
      WHERE d.day >= ${since}
      GROUP BY t.term
      ORDER BY sum(d.searches) DESC, t.term ASC
      LIMIT ${TERM_LIMIT}
    `);

    const rows = list.rows.slice(0, SEARCH_QUALITY_PAGE_SIZE).map(
      (row): SearchQualityQueryRow => ({
        queryNorm: String(row.query_norm),
        searches: Number(row.searches ?? 0),
        zeroResults: Number(row.zero_results ?? 0),
        fallbacks: Number(row.fallbacks ?? 0),
        clarifications: Number(row.clarifications ?? 0),
        lastResultCount:
          row.last_result_count === null || row.last_result_count === undefined
            ? null
            : Number(row.last_result_count),
        unrecognizedTerms: Array.isArray(row.unrecognized_terms)
          ? (row.unrecognized_terms as unknown[]).map(String)
          : [],
        lastSeenAt: new Date(row.last_seen_at as string | Date),
      }),
    );
    const total = totals.rows[0] ?? {};
    return {
      days,
      kind,
      page,
      rows,
      hasNext: list.rows.length > SEARCH_QUALITY_PAGE_SIZE,
      totals: {
        searches: Number(total.searches ?? 0),
        zeroResults: Number(total.zero_results ?? 0),
        fallbacks: Number(total.fallbacks ?? 0),
        queries: Number(total.queries ?? 0),
      },
      terms: terms.rows.map((row) => ({
        term: String(row.term),
        searches: Number(row.searches ?? 0),
        queries: Number(row.queries ?? 0),
      })),
    };
  });
}
