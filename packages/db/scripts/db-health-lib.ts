/**
 * Veritabani saglik raporunun sorgulari ve saf hesaplari. CLI `db-health.ts`,
 * testler `db-health-lib.test.ts`. Hicbir sorgu yazmaz; yalnizca katalog ve
 * istatistik gorunumlerini okur.
 *
 * Bolumler:
 * - Indekssiz foreign key: referans verilen satir silinince/guncellenince
 *   (ve urun birlestirmede) referans veren tablo bastan sona taranir.
 * - Gereksiz indeks: baska bir indeksin bas kolonlariyla ayni (ayni yontem,
 *   ayni kosul). Her yazimda bosuna guncellenir.
 * - Kullanilmayan indeks: istatistik sifirlandigindan beri hic taranmamis,
 *   benzersizlik saglamayan indeks.
 * - Olu satir: autovacuum'un geride kaldigi tablolar.
 * - En pahali sorgular: `pg_stat_statements` (etkinse).
 */
import type { Client } from "pg";

export interface IndexInfo {
  table: string;
  name: string;
  method: string;
  isUnique: boolean;
  isPrimary: boolean;
  /** `pg_get_indexdef(oid, k, true)` — "offer_id", "observed_at DESC", ifade metni. */
  columns: string[];
  predicate: string | null;
  sizeBytes: number;
}

export interface RedundantIndex {
  table: string;
  name: string;
  coveredBy: string;
  sizeBytes: number;
}

interface KeyColumn {
  expr: string;
  descending: boolean;
}

function parseColumn(raw: string): KeyColumn {
  let expr = raw.trim();
  // NULLS FIRST/LAST siralamayi degistirir ama ters taramada birlikte doner;
  // karsilastirmayi basit tutmak icin yon ile birlikte sadece DESC'e bakilir.
  expr = expr.replace(/\s+NULLS\s+(FIRST|LAST)$/i, "");
  const descending = /\s+DESC$/i.test(expr);
  expr = expr.replace(/\s+(ASC|DESC)$/i, "");
  return { expr, descending };
}

/**
 * `candidate`, `cover`un bas kolonlariyla ayni siradaysa ve B-tree ters
 * taramayla ayni sirayi verebiliyorsa (yonlerin hepsi ayni ya da hepsi ters)
 * gereksizdir.
 */
function isPrefixOf(candidate: KeyColumn[], cover: KeyColumn[]): boolean {
  if (candidate.length === 0 || candidate.length > cover.length) return false;
  let same = true;
  let flipped = true;
  for (const [i, column] of candidate.entries()) {
    const other = cover[i];
    if (!other || other.expr !== column.expr) return false;
    if (other.descending !== column.descending) same = false;
    else flipped = false;
  }
  return same || flipped;
}

/**
 * Kaldirilabilir indeksler. Benzersizlik (PK/UNIQUE) saglayan indeks ancak
 * kendisiyle birebir ayni baska bir benzersiz indeks varsa onerilir; kisitin
 * kendisi kaybolmasin. Esit ikiliden adi alfabetik olarak sonra gelen onerilir.
 */
export function findRedundantIndexes(indexes: readonly IndexInfo[]): RedundantIndex[] {
  const found: RedundantIndex[] = [];
  for (const candidate of indexes) {
    const keys = candidate.columns.map(parseColumn);
    for (const cover of indexes) {
      if (cover === candidate || cover.table !== candidate.table) continue;
      if (cover.method !== candidate.method || candidate.method !== "btree") continue;
      if ((cover.predicate ?? "") !== (candidate.predicate ?? "")) continue;
      const coverKeys = cover.columns.map(parseColumn);
      if (!isPrefixOf(keys, coverKeys)) continue;
      const identical = keys.length === coverKeys.length;
      if (candidate.isUnique || candidate.isPrimary) {
        // Benzersiz indeks yalnizca birebir ayni benzersiz bir esi varsa gereksiz.
        if (!(identical && (cover.isUnique || cover.isPrimary))) continue;
        if (candidate.isPrimary) continue;
      }
      // Birebir ayni iki sirada yalnizca biri raporlanir (kisit tasiyani korunur).
      if (identical && !(cover.isUnique || cover.isPrimary) && candidate.name < cover.name) {
        continue;
      }
      found.push({
        table: candidate.table,
        name: candidate.name,
        coveredBy: cover.name,
        sizeBytes: candidate.sizeBytes,
      });
      break;
    }
  }
  return found.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
}

export async function loadIndexes(client: Client): Promise<IndexInfo[]> {
  const { rows } = await client.query<{
    table: string;
    name: string;
    method: string;
    is_unique: boolean;
    is_primary: boolean;
    columns: string[];
    predicate: string | null;
    size_bytes: string;
  }>(`
    SELECT t.relname AS table, ic.relname AS name, am.amname AS method,
           i.indisunique AS is_unique, i.indisprimary AS is_primary,
           ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
                   FROM generate_series(1, i.indnkeyatts) AS k ORDER BY k) AS columns,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           pg_relation_size(i.indexrelid)::text AS size_bytes
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_am am ON am.oid = ic.relam
     WHERE t.relnamespace = 'public'::regnamespace
       AND NOT t.relispartition
  `);
  return rows.map((row) => ({
    table: row.table,
    name: row.name,
    method: row.method,
    isUnique: row.is_unique,
    isPrimary: row.is_primary,
    columns: row.columns,
    predicate: row.predicate,
    sizeBytes: Number(row.size_bytes),
  }));
}

export interface UnindexedForeignKey {
  table: string;
  constraint: string;
  columns: string[];
  references: string;
  estimatedRows: number;
}

/**
 * Bas kolonlari FK kolonlarini (sirasiz) kapsayan indeks yoksa raporlanir.
 * Kosulsuz ya da yalnizca `kolon IS NOT NULL` kosullu indeks sayilir: FK
 * denetimi esitlik aradigi icin NULL disi kismi indeks yeterlidir.
 */
export async function loadUnindexedForeignKeys(client: Client): Promise<UnindexedForeignKey[]> {
  const { rows } = await client.query<{
    table: string;
    constraint: string;
    columns: string[];
    references: string;
    estimated_rows: string;
  }>(`
    SELECT t.relname AS table, c.conname AS constraint,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                  ORDER BY k.n) AS columns,
           c.confrelid::regclass::text AS references,
           greatest(t.reltuples, 0)::bigint::text AS estimated_rows
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.contype = 'f'
       AND c.connamespace = 'public'::regnamespace
       AND NOT t.relispartition
       AND NOT EXISTS (
             SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid
                AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)]
                    @> c.conkey
                AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)]
                    <@ c.conkey
                AND (i.indpred IS NULL
                     OR pg_get_expr(i.indpred, i.indrelid) ~* '^\\(?[a-z_][a-z0-9_]* IS NOT NULL\\)?$'))
     ORDER BY t.reltuples DESC, t.relname, c.conname
  `);
  return rows.map((row) => ({
    table: row.table,
    constraint: row.constraint,
    columns: row.columns,
    references: row.references,
    estimatedRows: Number(row.estimated_rows),
  }));
}

export interface UnusedIndex {
  table: string;
  name: string;
  sizeBytes: number;
}

/** Benzersizlik saglamayan, hic taranmamis ve en az `minBytes` buyuklugundeki indeksler. */
export async function loadUnusedIndexes(
  client: Client,
  minBytes = 1024 * 1024,
): Promise<UnusedIndex[]> {
  const { rows } = await client.query<{ table: string; name: string; size_bytes: string }>(
    `
    SELECT s.relname AS table, s.indexrelname AS name,
           pg_relation_size(s.indexrelid)::text AS size_bytes
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      JOIN pg_class t ON t.oid = s.relid
     WHERE s.schemaname = 'public'
       AND s.idx_scan = 0
       AND NOT i.indisunique
       AND NOT t.relispartition
       AND pg_relation_size(s.indexrelid) >= $1
     ORDER BY pg_relation_size(s.indexrelid) DESC
    `,
    [minBytes],
  );
  return rows.map((row) => ({
    table: row.table,
    name: row.name,
    sizeBytes: Number(row.size_bytes),
  }));
}

export interface DeadTupleTable {
  table: string;
  live: number;
  dead: number;
  lastAutovacuum: Date | null;
}

/** Olu satir orani %20'yi ve 10 000 satiri gecen tablolar. */
export async function loadDeadTuples(client: Client): Promise<DeadTupleTable[]> {
  const { rows } = await client.query<{
    table: string;
    live: string;
    dead: string;
    last_autovacuum: Date | null;
  }>(`
    SELECT relname AS table, n_live_tup::text AS live, n_dead_tup::text AS dead,
           greatest(last_autovacuum, last_vacuum) AS last_autovacuum
      FROM pg_stat_user_tables
     WHERE schemaname = 'public'
       AND n_dead_tup >= 10000
       AND n_dead_tup > 0.2 * greatest(n_live_tup, 1)
     ORDER BY n_dead_tup DESC
  `);
  return rows.map((row) => ({
    table: row.table,
    live: Number(row.live),
    dead: Number(row.dead),
    lastAutovacuum: row.last_autovacuum,
  }));
}

export interface TopStatement {
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
  sharedBlocksRead: number;
}

export type StatementsReport =
  | { status: "ok"; statements: TopStatement[] }
  | { status: "not_installed" }
  | { status: "not_loaded" };

/** Sorgu metni rapora en fazla bu kadar girer (normalize metin; parametre degeri icermez). */
export const STATEMENT_TEXT_LIMIT = 200;

export function compactStatement(query: string): string {
  const oneLine = query.replace(/\s+/g, " ").trim();
  return oneLine.length > STATEMENT_TEXT_LIMIT
    ? `${oneLine.slice(0, STATEMENT_TEXT_LIMIT - 1)}…`
    : oneLine;
}

/** Toplam sureye gore en pahali `limit` sorgu. Eklenti semasi katalogdan bulunur. */
export async function loadTopStatements(client: Client, limit = 20): Promise<StatementsReport> {
  const ext = await client.query<{ schema: string }>(
    `SELECT n.nspname AS schema FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`,
  );
  const schema = ext.rows[0]?.schema;
  if (!schema) return { status: "not_installed" };
  const preload = await client.query<{ value: string }>(
    "SELECT current_setting('shared_preload_libraries') AS value",
  );
  if (!/(^|[\s,])pg_stat_statements($|[\s,])/.test(preload.rows[0]?.value ?? "")) {
    return { status: "not_loaded" };
  }
  const { rows } = await client.query<{
    query: string;
    calls: string;
    total_ms: number;
    mean_ms: number;
    rows: string;
    shared_blks_read: string;
  }>(
    `
    SELECT s.query, s.calls::text, s.total_exec_time AS total_ms, s.mean_exec_time AS mean_ms,
           s.rows::text, s.shared_blks_read::text
      FROM ${client.escapeIdentifier(schema)}.pg_stat_statements s
     WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
     ORDER BY s.total_exec_time DESC
     LIMIT $1
    `,
    [limit],
  );
  return {
    status: "ok",
    statements: rows.map((row) => ({
      query: compactStatement(row.query),
      calls: Number(row.calls),
      totalMs: row.total_ms,
      meanMs: row.mean_ms,
      rows: Number(row.rows),
      sharedBlocksRead: Number(row.shared_blks_read),
    })),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${bytes} B`;
}
