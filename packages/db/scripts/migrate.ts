/**
 * Migration'lari sirayla uygular.
 *
 * - Dosya adina gore siralanir (`NNNN_kisa_ad.sql`).
 * - Her dosya KENDI isleminde calisir; biri patlarsa oncekiler kalir,
 *   sonrakiler denenmez.
 * - Uygulananlar `schema_migration` tablosunda DOSYA ADIYLA tutulur (surum
 *   numarasi ya da checksum yok), ikinci kosu bos gecer.
 * - Yeniden adlandirma: `migrations/renamed.json` ("yeni ad" -> "eski ad").
 *   Eski adla uygulanmis bir migration, dosya yeniden numaralandirildiginda
 *   TEKRAR CALISTIRILMAZ: defter satiri tek islemde yeni ada tasinir. Her iki
 *   ad da defterdeyse tutarsizlik sayilir ve durur.
 * - `--plan`: hicbir sey yazmaz; defter tasimalarini ve uygulanacak dosyalari yazdirir.
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

const plan = process.argv.includes("--plan");

function readRenames(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(migrationsDir, "renamed.json"), "utf8")) as {
      renames?: Record<string, string>;
    };
    return raw.renames ?? {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const renames = readRenames();

  await withClient(ownerUrl(), async (client) => {
    if (!plan) await client.query(BOOKKEEPING);
    const exists = await client.query("SELECT to_regclass('public.schema_migration') AS t");
    const { rows } = exists.rows[0]?.t
      ? await client.query<{ filename: string }>("SELECT filename FROM schema_migration")
      : { rows: [] as { filename: string }[] };
    const applied = new Set(rows.map((row) => row.filename));

    // Defter tasimalari: eski adla uygulanmis, yeni adla henuz kayitli olmayan migration.
    const moves: [from: string, to: string][] = [];
    for (const [next, previous] of Object.entries(renames)) {
      if (!files.includes(next)) continue;
      if (applied.has(next) && applied.has(previous)) {
        throw new Error(`Defter tutarsiz: hem ${previous} hem ${next} uygulanmis gorunuyor.`);
      }
      if (applied.has(previous) && !applied.has(next)) moves.push([previous, next]);
    }
    for (const [from, to] of moves) {
      if (plan) {
        console.log(`  [plan] defter tasima: ${from} -> ${to} (SQL calismaz)`);
        applied.delete(from);
        applied.add(to);
        continue;
      }
      await client.query("BEGIN");
      try {
        const moved = await client.query(
          "UPDATE schema_migration SET filename = $2 WHERE filename = $1",
          [from, to],
        );
        if (moved.rowCount !== 1) throw new Error(`Defter satiri bulunamadi: ${from}`);
        await client.query("COMMIT");
        console.log(`  defter tasindi: ${from} -> ${to} (SQL yeniden calistirilmadi)`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.delete(from);
      applied.add(to);
    }

    const pending = files.filter((name) => !applied.has(name));

    if (pending.length === 0) {
      console.log(`Uygulanacak migration yok. (${applied.size} dosya zaten uygulanmis)`);
      return;
    }
    if (plan) {
      for (const filename of pending) console.log(`  [plan] uygulanacak: ${filename}`);
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
