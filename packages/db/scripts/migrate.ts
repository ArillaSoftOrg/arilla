/**
 * Migration'lari sirayla uygular.
 *
 * - Dosya adina gore siralanir (`NNNN_kisa_ad.sql`).
 * - Her dosya KENDI isleminde calisir; biri patlarsa oncekiler kalir,
 *   sonrakiler denenmez.
 * - Uygulananlar `schema_migration` tablosunda tutulur, ikinci kosu bos gecer.
 * - Sahip rolle (`DATABASE_URL_OWNER`) baglanir.
 * - Ayni anda tek calistirici (oturum duzeyi advisory lock; karar 0111).
 * - Her dosyada `lock_timeout` ve `statement_timeout` (SET LOCAL): kilit
 *   alinamazsa sorgulari arkasinda biriktirmek yerine hizla duser, dosya geri
 *   alinir. Varsayilan 5s / 15min; `MIGRATION_LOCK_TIMEOUT`,
 *   `MIGRATION_STATEMENT_TIMEOUT` ile degistirilir.
 * - `-- kind: concurrent` (karar 0125) dosyalari islem DISINDA, ifade ifade
 *   calisir (CONCURRENTLY islem icinde calismaz). Indeks yazimi kilitlemez ama
 *   eski islemlerin bitmesini bekler; bu yuzden kendi kilit suresi vardir
 *   (`MIGRATION_CONCURRENT_LOCK_TIMEOUT`, varsayilan 10min). Yarim kalan
 *   `CREATE INDEX CONCURRENTLY` geride GECERSIZ bir indeks birakir ve
 *   `IF NOT EXISTS` onu sessizce gecerdi: calistirici once gecersiz indeksi
 *   kaldirir, olusturduktan sonra gecerli oldugunu dogrular. Dosya ancak tum
 *   ifadeler bitince `schema_migration`a yazilir; yeniden kosu idempotenttir.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { assertRemoteWriteConfirmed, migrationsDir, ownerUrl, withClient } from "./lib.ts";
import { CONCURRENT_CREATE, splitStatements } from "./migration-lint.ts";

/** Sabit kilit anahtari: "arilla migrate". Baska hicbir yerde kullanilmaz. */
const MIGRATE_LOCK_KEY = 7_204_311_065;
const DURATION = /^[0-9]{1,6}(ms|s|min)$/;

function timeoutSetting(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!DURATION.test(value)) {
    throw new Error(`${name} gecersiz (ornek: 5s, 500ms, 15min)`);
  }
  return value;
}

/** `public` semadaki indeksin gecerlilik durumu; yoksa `null`. */
async function indexValidity(client: Client, name: string): Promise<boolean | null> {
  const { rows } = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
    [name],
  );
  return rows[0]?.valid ?? null;
}

async function applyConcurrent(
  client: Client,
  filename: string,
  sql: string,
  timeouts: { lock: string; statement: string },
): Promise<void> {
  // Islem yok: SET LOCAL calismaz; oturum ayari dosya sonunda geri alinir.
  await client.query(`SET lock_timeout = '${timeouts.lock}'`);
  await client.query(`SET statement_timeout = '${timeouts.statement}'`);
  try {
    for (const statement of splitStatements(sql)) {
      const created = CONCURRENT_CREATE.exec(statement)?.[1];
      if (created && (await indexValidity(client, created)) === false) {
        console.log(`\n    gecersiz ${created} (yarim kalmis onceki kosu) kaldiriliyor`);
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${created}`);
      }
      await client.query(statement);
      if (created && (await indexValidity(client, created)) !== true) {
        throw new Error(`${filename}: ${created} olusturuldu ama gecerli degil`);
      }
    }
    await client.query("INSERT INTO schema_migration (filename) VALUES ($1)", [filename]);
  } finally {
    await client.query("RESET lock_timeout");
    await client.query("RESET statement_timeout");
  }
}

const BOOKKEEPING = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    filename    TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

async function main(): Promise<void> {
  assertRemoteWriteConfirmed("db:migrate");
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const lockTimeout = timeoutSetting("MIGRATION_LOCK_TIMEOUT", "5s");
  const statementTimeout = timeoutSetting("MIGRATION_STATEMENT_TIMEOUT", "15min");
  const concurrentLockTimeout = timeoutSetting("MIGRATION_CONCURRENT_LOCK_TIMEOUT", "10min");

  await withClient(ownerUrl(), async (client) => {
    // Oturum duzeyi kilit; baglanti kapaninca kendiliginden birakilir.
    const { rows: lock } = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [MIGRATE_LOCK_KEY],
    );
    if (!lock[0]?.ok) {
      throw new Error(
        "Baska bir migration calistiricisi aktif; ayni anda iki calistirici calismaz.",
      );
    }
    await client.query(BOOKKEEPING);
    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migration",
    );
    const applied = new Set(rows.map((row) => row.filename));
    const pending = files.filter((name) => !applied.has(name));

    if (pending.length === 0) {
      console.log(`Uygulanacak migration yok. (${applied.size} dosya zaten uygulanmis)`);
      return;
    }

    for (const filename of pending) {
      const sql = readFileSync(join(migrationsDir, filename), "utf8");
      process.stdout.write(`  ${filename} ... `);
      if (/^--\s*kind:\s*concurrent\s*$/m.test(sql)) {
        try {
          await applyConcurrent(client, filename, sql, {
            lock: concurrentLockTimeout,
            statement: statementTimeout,
          });
          console.log("tamam (islem disi)");
        } catch (error) {
          console.log("HATA");
          throw error;
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        // Degerler DURATION ile dogrulandi; SET parametre baglamayi desteklemez.
        await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
        await client.query(`SET LOCAL statement_timeout = '${statementTimeout}'`);
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        console.log("tamam");
      } catch (error) {
        await client.query("ROLLBACK");
        console.log("HATA");
        throw error;
      }
    }
    console.log(`${pending.length} migration uygulandi.`);
  });
}

await main();
