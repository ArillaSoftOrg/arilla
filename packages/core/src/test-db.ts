/**
 * Yalnizca entegrasyon testleri icindir - `index.ts`'ten disa acilmaz.
 * Arama'ya ozel degil: `search/` ve `attribution/` entegrasyon testlerinin
 * ikisi de burayi kullanir. `packages/db/scripts/lib.ts`'teki
 * `loadDotEnv`/`ownerUrl` deseninin ayni mantigi: `packages/core` baska bir
 * paketin `scripts/` dizinine uzanmamali, bu yuzden kucuk olcekte burada
 * tekrarlanir.
 *
 * Kurulum/temizlik `DATABASE_URL_OWNER` (sahip rol), test edilen kod
 * `DATABASE_URL` (arilla_app) kullanir - services/ingest/tests/
 * test_pipeline.py'nin izledigi desenin aynisi.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, type Database } from "@arilla/db";
import { Client } from "pg";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadDotEnv(): void {
  for (const candidate of [join(repoRoot, ".env"), join(repoRoot, ".env.local")]) {
    let raw: string;
    try {
      raw = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (key === undefined || rawValue === undefined) continue;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  }
}

function requireEnv(name: string): string {
  loadDotEnv();
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} tanimli degil - entegrasyon testleri icin repo kokunde .env gerekir.`);
  }
  return value;
}

/** Test edilen kodun baglanacagi uygulama rolu (arilla_app). */
export function getTestDb(): Database {
  return createDatabase(requireEnv("DATABASE_URL"));
}

/** Fixture kurulum/temizligi icin sahip rol. */
export async function withOwnerClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: requireEnv("DATABASE_URL_OWNER") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
