/**
 * "Curated havuz yükleme aracı" (docs/backlog.md E4). docs/routes.md
 * "Soğuk başlangıç": ~300 ürünlük havuz, seçim kriterleri (temiz fotoğraf,
 * iyi fiyat konumu, dengeli kategori dağılımı, stokta olma) editöryel -
 * bu script yalnızca ürünün var olduğunu ve kategorisinin `is_discoverable`
 * olduğunu doğrulayıp `public_find`'a yazar.
 *
 * Kullanım:
 *   pnpm --filter @arilla/core curated:load urunler.json
 * urunler.json: product.slug dizisi, örn. ["elbise-a", "canta-b"]
 *
 * `packages/core` başka bir paketin `scripts/` dizinine uzanmıyor -
 * `test-db.ts`'teki .env yükleme deseni burada da tekrarlanır (bkz. o
 * dosyanın başlığı).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  addToCuratedPool,
  ProductNotDiscoverableError,
  ProductNotFoundError,
} from "../src/discovery-feed/curated-pool.ts";

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

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("kullanim: node load-curated-pool.ts urunler.json");
    process.exitCode = 1;
    return;
  }

  loadDotEnv();
  const { getDatabase, product } = await import("@arilla/db");
  const db = getDatabase();

  const slugs: string[] = JSON.parse(readFileSync(filePath, "utf8"));

  let added = 0;
  let skipped = 0;
  for (const slug of slugs) {
    const rows = await db
      .select({ id: product.id })
      .from(product)
      .where(eq(product.slug, slug))
      .limit(1);
    const row = rows[0];
    if (!row) {
      console.warn(`atlandi (bulunamadi): ${slug}`);
      skipped++;
      continue;
    }
    try {
      await addToCuratedPool(db, row.id);
      added++;
    } catch (error) {
      if (error instanceof ProductNotDiscoverableError || error instanceof ProductNotFoundError) {
        console.warn(`atlandi: ${slug} - ${error.message}`);
        skipped++;
        continue;
      }
      throw error;
    }
  }

  console.log(`eklendi: ${added}, atlandi: ${skipped}`);
}

main();
