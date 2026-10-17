/**
 * Veritabani saglik raporu (salt okunur). Darbogaz calismasinin olcum adimi:
 * indekssiz foreign key'ler, gereksiz/kullanilmayan indeksler, olu satir
 * birikimi, arama olay kuyrugu birikimi (karar 0136) ve en pahali sorgular
 * (`pg_stat_statements`, migration 0081).
 *
 * Hicbir sey yazmaz; uzak veritabaninda da onaysiz calisir (`--check`
 * betikleriyle ayni). Sorgu metni normalize bicimdedir ($1, $2), parametre
 * degeri icermez. Kullanim: `pnpm db:health`. Bkz. docs/ops.md.
 */
import {
  describeSearchOutbox,
  findRedundantIndexes,
  formatBytes,
  loadDeadTuples,
  loadIndexes,
  loadSearchOutbox,
  loadTopStatements,
  loadUnindexedForeignKeys,
  loadUnusedIndexes,
} from "./db-health-lib.ts";
import { ownerUrl, withClient } from "./lib.ts";

await withClient(ownerUrl(), async (client) => {
  // Salt okunur oturum: yanlislikla eklenen bir yazim motor duzeyinde reddedilir.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '30s'");

  const section = (title: string) => console.log(`\n== ${title}`);

  section("Indekssiz foreign key (referans silinince/birlestirilince tam tarama)");
  const fks = await loadUnindexedForeignKeys(client);
  if (fks.length === 0) console.log("  yok");
  for (const fk of fks) {
    console.log(
      `  ${fk.table}(${fk.columns.join(", ")}) -> ${fk.references}  [${fk.constraint}, ~${fk.estimatedRows} satir]`,
    );
  }

  section("Gereksiz indeks (baska indeksin bas kolonlari)");
  const redundant = findRedundantIndexes(await loadIndexes(client));
  if (redundant.length === 0) console.log("  yok");
  for (const index of redundant) {
    console.log(
      `  ${index.table}.${index.name} (${formatBytes(index.sizeBytes)}) <- ${index.coveredBy}`,
    );
  }

  section("Kullanilmayan indeks (istatistik sifirlanmasindan beri idx_scan = 0, >= 1 MB)");
  const stats = await client.query<{ since: Date | null }>(
    "SELECT stats_reset AS since FROM pg_stat_database WHERE datname = current_database()",
  );
  const since = stats.rows[0]?.since;
  console.log(`  istatistik baslangici: ${since ? since.toISOString() : "kurulumdan beri"}`);
  const unused = await loadUnusedIndexes(client);
  if (unused.length === 0) console.log("  yok");
  for (const index of unused) {
    console.log(`  ${index.table}.${index.name} (${formatBytes(index.sizeBytes)})`);
  }

  section("Olu satir birikimi (>= 10 000 ve canli satirin %20'si)");
  const dead = await loadDeadTuples(client);
  if (dead.length === 0) console.log("  yok");
  for (const table of dead) {
    const vacuum = table.lastAutovacuum ? table.lastAutovacuum.toISOString() : "hic";
    console.log(`  ${table.table}: ${table.dead} olu / ${table.live} canli, son vacuum ${vacuum}`);
  }

  section("Arama indeksi olay kuyrugu (search_outbox)");
  const outbox = await loadSearchOutbox(client);
  if (!outbox) console.log("  tablo yok");
  else for (const line of describeSearchOutbox(outbox)) console.log(`  ${line}`);

  section("En pahali sorgular (toplam sure)");
  const top = await loadTopStatements(client);
  if (top.status === "not_installed") {
    console.log("  pg_stat_statements kurulu degil (migration 0081 uygulanmamis).");
  } else if (top.status === "not_loaded") {
    console.log(
      "  pg_stat_statements yuklu degil: shared_preload_libraries ayari Postgres yeniden " +
        "baslatilinca etkinlesir (infra/vps/postgres/postgresql.conf).",
    );
  } else if (top.statements.length === 0) {
    console.log("  henuz kayit yok");
  } else {
    for (const [i, s] of top.statements.entries()) {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${s.totalMs.toFixed(0)} ms toplam · ${s.calls} cagri · ` +
          `${s.meanMs.toFixed(1)} ms ort · ${s.rows} satir · ${s.sharedBlocksRead} blok okuma`,
      );
      console.log(`      ${s.query}`);
    }
  }
});
