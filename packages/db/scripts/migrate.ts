/**
 * Migration'lari sirayla uygular.
 *
 * - Dosya adina gore siralanir (`NNNN_kisa_ad.sql`).
 * - Her dosya KENDI isleminde calisir; biri patlarsa oncekiler kalir,
 *   sonrakiler denenmez.
 * - Uygulananlar `schema_migration` tablosunda tutulur, ikinci kosu bos gecer.
 * - Sahip rolle (`DATABASE_URL_OWNER`) baglanir.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir, ownerUrl, withClient } from "./lib.ts";

const BOOKKEEPING = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    filename    TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

async function main(): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  await withClient(ownerUrl(), async (client) => {
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
      await client.query("BEGIN");
      try {
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
