/**
 * Katalog telemetrisi — SALT OKUNUR tanilama (docs/catalog-120m-audit.md Ek A).
 *
 * Amac: katalog buyurken "kaldir / ayarla / ayir" kararlarini varsayimla degil
 * olcumle vermek. Bu betik HICBIR ayar degistirmez, vacuum/analyze calistirmaz,
 * veri yazmaz. Otomatik calistirilmaz: cron, CI, dagitim adimi ya da
 * `package.json` yasam dongusu betigi YOKTUR; yalnizca elle.
 *
 *   pnpm db:catalog-telemetry                 # yerel veritabani, ozet tablolar
 *   pnpm db:catalog-telemetry --json          # makine okur cikti (iki olcumu karsilastirmak icin)
 *   pnpm db:catalog-telemetry --growth        # sinirli buyume sayimlari (agir olabilir)
 *   pnpm db:catalog-telemetry --bloat         # pgstattuple_approx (eklenti varsa; sayfa okur)
 *   pnpm db:catalog-telemetry --remote        # YEREL OLMAYAN veritabani: bayrak sart
 *
 * Guvenceler:
 *   - Her sorgu `SELECT`/`WITH` ile baslar ve yazma/DDL/bakim kelimesi tasimaz
 *     (calistirmadan once denetlenir).
 *   - Tek islem `READ ONLY`; `statement_timeout`, `lock_timeout` ve
 *     `idle_in_transaction_session_timeout` yerel (`SET LOCAL`).
 *   - Yerel olmayan baglanti `--remote` olmadan reddedilir.
 *   - Sorgu metinleri `pg_stat_statements` normalize halidir (parametre degeri
 *     yok) ve 200 karaktere kisaltilir; kisisel veri yazdirilmaz.
 *
 * Sayaclar son istatistik sifirlamasindan (`stats_reset`) beri birikir; cikti
 * bunu ve sunucu calisma suresini basar. Kisa pencereyle "kullanilmiyor"
 * sonucuna VARILMAZ.
 */
import { pathToFileURL } from "node:url";
import type { Client } from "pg";
import { isLocal, ownerUrl, withClient } from "./lib.ts";

/** Katalog cekirdegi. `price_point_*` partition'lari ayrica toplanir. */
export const CATALOG_TABLES = [
  "merchant",
  "brand",
  "category",
  "product",
  "product_slug_history",
  "offer",
  "offer_variant",
  "variant_stock_event",
  "variant_price_event",
  "price_point",
  "product_price_stats",
  "embedding",
  "match_candidate",
  "similarity_edge",
  "generated_content",
  "ingest_run",
  "job_run",
  "query_resolution",
  "query_interpretation",
  "search_query_day",
] as const;

const FORBIDDEN =
  /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|vacuum|analyze|reindex|cluster|refresh|copy|call|do|set|reset|lock|comment)\b/i;

/** Calistirilmadan once her sorgunun salt okunur oldugunu denetler. */
export function assertReadOnlySql(sqlText: string): void {
  if (!/^\s*(select|with)\b/i.test(sqlText)) {
    throw new Error(`salt okunur olmayan sorgu reddedildi: ${sqlText.slice(0, 60)}`);
  }
  // Sabit metin ('...') ve satir ici aciklamalar denetimden once atilir.
  const stripped = sqlText.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/gm, "");
  const hit = FORBIDDEN.exec(stripped);
  if (hit) throw new Error(`salt okunur olmayan kelime '${hit[1]}' reddedildi`);
  if (stripped.trim().replace(/;$/, "").includes(";")) {
    throw new Error("tek ifade beklenir (noktali virgul bulundu)");
  }
}

export interface Probe {
  key: string;
  title: string;
  sql: string;
  params?: unknown[];
  /** Eklenti/bayrak yoksa atlanir. */
  requires?: "pg_stat_statements" | "pgstattuple" | "growth" | "bloat";
}

const tables = [...CATALOG_TABLES];

export const PROBES: Probe[] = [
  {
    key: "server",
    title: "Sunucu ve istatistik penceresi",
    sql: `
      SELECT current_setting('server_version') AS server_version,
             pg_size_pretty(pg_database_size(current_database())) AS database_size,
             now() - pg_postmaster_start_time() AS uptime,
             (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset,
             now() - (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_window
    `,
  },
  {
    key: "tables",
    title: "Tablo boyutu, satir, olu satir, tarama ve HOT (partition'lar price_point'e toplanir)",
    sql: `
      SELECT CASE WHEN relname LIKE 'price_point\\_%' THEN 'price_point (partitions)' ELSE relname END AS relation,
             count(*)                                               AS parts,
             sum(n_live_tup)::bigint                                AS live_rows,
             sum(n_dead_tup)::bigint                                AS dead_rows,
             round(100.0 * sum(n_dead_tup) / nullif(sum(n_live_tup) + sum(n_dead_tup), 0), 2) AS dead_pct,
             pg_size_pretty(sum(pg_relation_size(relid)))           AS heap,
             pg_size_pretty(sum(pg_indexes_size(relid)))            AS indexes,
             pg_size_pretty(sum(pg_total_relation_size(relid)))     AS total,
             sum(seq_scan)::bigint                                  AS seq_scan,
             sum(seq_tup_read)::bigint                              AS seq_tup_read,
             sum(idx_scan)::bigint                                  AS idx_scan,
             sum(n_tup_ins)::bigint                                 AS ins,
             sum(n_tup_upd)::bigint                                 AS upd,
             sum(n_tup_hot_upd)::bigint                             AS hot_upd,
             round(100.0 * sum(n_tup_hot_upd) / nullif(sum(n_tup_upd), 0), 1) AS hot_pct,
             sum(n_tup_del)::bigint                                 AS del
        FROM pg_stat_user_tables
       WHERE relname = ANY($1::text[]) OR relname LIKE 'price_point\\_%'
       GROUP BY 1
       ORDER BY sum(pg_total_relation_size(relid)) DESC
    `,
    params: [tables],
  },
  {
    key: "vacuum",
    title: "Autovacuum / autoanalyze durumu ve tablo bazli ayarlar (partition'lar dahil degil)",
    sql: `
      SELECT s.relname,
             s.last_autovacuum, s.autovacuum_count, s.last_vacuum,
             s.last_autoanalyze, s.autoanalyze_count,
             s.n_dead_tup, s.n_mod_since_analyze,
             c.reloptions,
             c.relpages, c.reltuples::bigint AS reltuples
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.oid = s.relid
       WHERE s.relname = ANY($1::text[])
       ORDER BY s.n_dead_tup DESC
    `,
    params: [tables],
  },
  {
    key: "vacuum_settings",
    title: "Etkin autovacuum ayarlari (yalnizca okunur)",
    sql: `
      SELECT name, setting, unit, source
        FROM pg_settings
       WHERE name LIKE 'autovacuum%' OR name IN ('maintenance_work_mem','shared_buffers',
             'effective_cache_size','work_mem','max_connections','statement_timeout',
             'wal_level','max_wal_size','track_counts')
       ORDER BY name
    `,
  },
  {
    key: "indexes",
    title: "Indeks boyutu ve kullanimi (idx_scan = 0 ve benzersiz degil = ADAY, kanit degil)",
    sql: `
      SELECT s.relname AS relation, s.indexrelname AS index,
             pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
             pg_relation_size(s.indexrelid) AS size_bytes,
             s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
             i.indisunique AS is_unique, i.indisprimary AS is_pk,
             (s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary) AS unused_candidate,
             pg_get_indexdef(s.indexrelid) AS definition
        FROM pg_stat_user_indexes s
        JOIN pg_index i ON i.indexrelid = s.indexrelid
       WHERE s.relname = ANY($1::text[]) OR s.relname LIKE 'price_point\\_%'
       ORDER BY pg_relation_size(s.indexrelid) DESC
       LIMIT 80
    `,
    params: [tables],
  },
  {
    key: "partitions",
    title: "price_point partition'lari (aylik buyume)",
    sql: `
      SELECT c.relname AS partition, c.reltuples::bigint AS est_rows,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
             pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'price_point'
       ORDER BY c.relname
    `,
  },
  {
    key: "statements",
    title: "En pahali katalog/arama sorgulari (pg_stat_statements; normalize metin)",
    requires: "pg_stat_statements",
    sql: `
      SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms,
             round(max_exec_time::numeric, 1) AS max_ms,
             round(total_exec_time::numeric) AS total_ms,
             rows, shared_blks_read,
             left(regexp_replace(regexp_replace(query, '\\s+', ' ', 'g'), '''[^'']*''', '''?''', 'g'), 200) AS query
        FROM pg_stat_statements
       WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND query ~* '\\m(offer|product|offer_variant|price_point|embedding|similarity_edge|match_candidate|ingest_run)\\M'
         AND query !~* 'pg_stat|pg_class|pg_index'
       ORDER BY total_exec_time DESC
       LIMIT 25
    `,
  },
  {
    key: "row_width",
    title: "Ortalama satir genisligi (%1 ornek; varsayimlari dogrular)",
    sql: `
      SELECT 'offer' AS what, count(*) AS sample, avg(pg_column_size(o.*))::int AS avg_bytes,
             max(pg_column_size(o.*)) AS max_bytes
        FROM offer o TABLESAMPLE SYSTEM (1)
      UNION ALL
      SELECT 'offer.attributes_raw', count(*), avg(pg_column_size(attributes_raw))::int,
             max(pg_column_size(attributes_raw)) FROM offer TABLESAMPLE SYSTEM (1)
      UNION ALL
      SELECT 'offer_variant', count(*), avg(pg_column_size(v.*))::int, max(pg_column_size(v.*))
        FROM offer_variant v TABLESAMPLE SYSTEM (1)
      UNION ALL
      SELECT 'product', count(*), avg(pg_column_size(p.*))::int, max(pg_column_size(p.*))
        FROM product p TABLESAMPLE SYSTEM (1)
    `,
  },
  {
    key: "growth_offer",
    title: "Buyume: son 30 gunde gunluk yeni offer / urun (tam tarama olabilir)",
    requires: "growth",
    sql: `
      SELECT 'offer' AS what, date_trunc('day', first_seen_at)::date AS day, count(*) AS n
        FROM offer WHERE first_seen_at >= now() - interval '30 days' GROUP BY 1, 2
      UNION ALL
      SELECT 'product', date_trunc('day', created_at)::date, count(*)
        FROM product WHERE created_at >= now() - interval '30 days' GROUP BY 1, 2
      ORDER BY 1, 2
    `,
  },
  {
    key: "growth_runs",
    title: "Buyume/davranis: son 30 gunde gunluk toplama koşulari (ingest_run)",
    requires: "growth",
    sql: `
      SELECT date_trunc('day', started_at)::date AS day, status,
             count(*) AS runs, sum(offers_seen) AS offers_seen,
             sum(offers_created) AS created, sum(offers_updated) AS updated,
             sum(price_points_written) AS price_points
        FROM ingest_run WHERE started_at >= now() - interval '30 days'
       GROUP BY 1, 2 ORDER BY 1, 2
    `,
  },
  {
    key: "bloat",
    title: "Bloat sinyali: pgstattuple_approx (offer, offer_variant, product)",
    requires: "bloat",
    sql: `
      SELECT t.relname AS relation, a.approx_tuple_percent, a.dead_tuple_percent,
             a.approx_free_percent, pg_size_pretty(a.table_len) AS table_len
        FROM (VALUES ('offer'), ('offer_variant'), ('product')) AS t(relname),
             LATERAL pgstattuple_approx(t.relname::regclass) AS a
    `,
  },
];

/**
 * Hata mesajlarindan baglanti adresi/parola/anahtar izlerini ayiklar. `pg`
 * hatalari genelde bunlari tasimaz; yine de cikti her zaman bu suzgecten gecer.
 */
export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi, "$1=<gizli>")
    .slice(0, 300);
}

async function extensionInstalled(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query("SELECT 1 FROM pg_extension WHERE extname = $1", [name]);
  return rows.length > 0;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const url = ownerUrl();
  if (!isLocal(url) && !args.has("--remote")) {
    console.error(
      "Baglanti yerel degil. Uretim/uzak veritabaninda calistirmak icin --remote verin.\n" +
        "Bu betik salt okunurdur ama elle ve bilincli calistirilir; otomatiklestirmeyin.",
    );
    process.exit(2);
  }

  for (const probe of PROBES) assertReadOnlySql(probe.sql);

  const report: Record<string, unknown> = {
    taken_at: new Date().toISOString(),
    remote: !isLocal(url),
  };

  await withClient(url, async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");

      const hasStatements = await extensionInstalled(client, "pg_stat_statements");
      const hasTuple = await extensionInstalled(client, "pgstattuple");

      for (const probe of PROBES) {
        if (probe.requires === "growth" && !args.has("--growth")) continue;
        if (probe.requires === "bloat" && !args.has("--bloat")) continue;
        if (probe.requires === "pg_stat_statements" && !hasStatements) {
          report[probe.key] = "atlandi: pg_stat_statements eklentisi yok";
          continue;
        }
        if (probe.requires === "bloat" && !hasTuple) {
          report[probe.key] = "atlandi: pgstattuple eklentisi yok";
          continue;
        }
        // Bir sorgunun zaman asimi digerlerini dusurmesin: SAVEPOINT.
        await client.query("SAVEPOINT probe");
        try {
          const { rows } = await client.query(probe.sql, probe.params);
          report[probe.key] = rows;
          await client.query("RELEASE SAVEPOINT probe");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT probe");
          report[probe.key] = `HATA: ${(error as Error).message}`;
        }
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const probe of PROBES) {
    if (!(probe.key in report)) continue;
    console.log(`\n== ${probe.title}`);
    const value = report[probe.key];
    if (typeof value === "string") console.log(value);
    else console.table(value);
  }
}

// Yalnizca dogrudan calistirilinca; testler `PROBES`/`assertReadOnlySql`i import eder.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Telemetri basarisiz: ${sanitizeError(error)}`);
    process.exit(1);
  }
}
