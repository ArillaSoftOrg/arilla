/**
 * Hepsiburada (sitemap) kategori referansini dogrular ve tohum migration'ini uretir (karar 0144).
 *
 *   node scripts/hepsiburada-categories.ts            ham sitemap'i ozetler (yazmaz)
 *   node scripts/hepsiburada-categories.ts --check    tohum migration'i ham sitemap ile uyumlu mu
 *   node scripts/hepsiburada-categories.ts --generate tohum migration'ini yeniden yazar
 *
 * Agdan okumaz ve veritabanina baglanmaz.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHepsiburadaSitemap, renderSeedMigration } from "./hepsiburada-categories-lib.ts";
import { sha256Hex } from "./trendyol-categories-lib.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_NUMBER = "0099";
const SEED_FILE = `${SEED_NUMBER}_hepsiburada_category_reference_seed.sql`;
const rawPath = join(packageRoot, "../../docs/reference/hepsiburada/categories.raw.xml");
const seedPath = join(packageRoot, "migrations", SEED_FILE);

const bytes = readFileSync(rawPath);
const sha = sha256Hex(bytes);
const { rows, stats } = parseHepsiburadaSitemap(bytes.toString("utf8"));
const seed = renderSeedMigration(SEED_NUMBER, sha, stats, rows);

console.log(`sha256 ${sha}`);
console.log(JSON.stringify(stats));

if (process.argv.includes("--generate")) {
  writeFileSync(seedPath, seed);
  console.log(`yazildi: ${seedPath}`);
} else if (process.argv.includes("--check")) {
  let current: string | null = null;
  try {
    current = readFileSync(seedPath, "utf8");
  } catch {
    current = null;
  }
  if (current !== seed) {
    console.error(`ham sitemap ile uyumsuz (--generate calistirin): ${SEED_FILE}`);
    process.exit(1);
  }
  console.log("tohum migration'i ham sitemap ile uyumlu");
}
