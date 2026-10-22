/**
 * Trendyol kategori referansini dogrular ve tohum migration'ini uretir (karar 0143).
 *
 *   node scripts/trendyol-categories.ts            ham JSON'u ozetler (varsayilan, yazmaz)
 *   node scripts/trendyol-categories.ts --check    ayristirilmis dosya + migration ham JSON ile uyumlu mu
 *   node scripts/trendyol-categories.ts --generate ayristirilmis dosyayi ve tohum migration'ini yeniden yazar
 *
 * Agdan okumaz ve veritabanina baglanmaz. Ham JSON'u yenilemek ayri, bilincli bir adimdir
 * (docs/reference/trendyol/README.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTrendyolTree,
  renderParsedJson,
  renderSeedMigration,
  sha256Hex,
} from "./trendyol-categories-lib.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_NUMBER = "0097";
const SEED_FILE = `${SEED_NUMBER}_trendyol_category_reference_seed.sql`;
const refDir = join(packageRoot, "../../docs/reference/trendyol");
const rawPath = join(refDir, "product-categories.raw.json");
const parsedPath = join(refDir, "product-categories.parsed.json");
const seedPath = join(packageRoot, "migrations", SEED_FILE);

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const rawBytes = readFileSync(rawPath);
const sha = sha256Hex(rawBytes);
const { nodes, stats } = parseTrendyolTree(rawBytes.toString("utf8"));
const parsed = renderParsedJson(sha, stats, nodes);
const seed = renderSeedMigration(SEED_NUMBER, sha, stats, nodes);

console.log(`sha256 ${sha}`);
console.log(
  `toplam ${stats.total}, ana ${stats.roots}, yaprak ${stats.leaves}, derinlik ${stats.maxDepth}, tekrar ${stats.duplicateIds.length}`,
);
console.log("seviye basina", JSON.stringify(stats.perDepth));

if (process.argv.includes("--generate")) {
  writeFileSync(parsedPath, parsed);
  writeFileSync(seedPath, seed);
  console.log(`yazildi: ${parsedPath}\nyazildi: ${seedPath}`);
} else if (process.argv.includes("--check")) {
  const stale = [
    read(parsedPath) === parsed ? null : "product-categories.parsed.json",
    read(seedPath) === seed ? null : SEED_FILE,
  ].filter((name) => name !== null);
  if (stale.length > 0) {
    console.error(`ham JSON ile uyumsuz (--generate calistirin): ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log("ayristirilmis dosya ve tohum migration'i ham JSON ile uyumlu");
}
