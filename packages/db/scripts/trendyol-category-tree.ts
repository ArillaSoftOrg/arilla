/**
 * Trendyol kategori agacini aktif ManiCepte agacina entegre eden migration'i, kalici esleme
 * CSV'sini ve geri alma betigini uretir (karar 0153).
 *
 *   node scripts/trendyol-category-tree.ts            plani ozetler (varsayilan, yazmaz)
 *   node scripts/trendyol-category-tree.ts --check    uretilen dosyalar plan ile uyumlu mu
 *   node scripts/trendyol-category-tree.ts --generate migration, CSV ve geri alma betigini yazar
 *
 * Girdi: ham Trendyol JSON'u (docs/reference/trendyol) ve entegrasyon ONCESI ManiCepte agacinin
 * degismez goruntusu (docs/reference/categories/manicepte-baseline-158.tsv). Agdan okumaz ve
 * veritabanina baglanmaz.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrendyolTree, sha256Hex } from "./trendyol-categories-lib.ts";
import {
  MIGRATION_NUMBER,
  parseBaseline,
  planTree,
  renderCsv,
  renderMigration,
  renderRollback,
} from "./trendyol-category-tree-lib.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(packageRoot, "../../docs/reference");
const rawPath = join(docsRoot, "trendyol/product-categories.raw.json");
const baselinePath = join(docsRoot, "categories/manicepte-baseline-158.tsv");
const migrationFile = `${MIGRATION_NUMBER}_trendyol_category_tree.sql`;
const outputs = {
  migration: join(packageRoot, "migrations", migrationFile),
  csv: join(docsRoot, "trendyol/category-tree-map.csv"),
  rollback: join(docsRoot, "trendyol/category-tree-rollback.sql"),
};

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const rawBytes = readFileSync(rawPath);
const sha = sha256Hex(rawBytes);
const { nodes } = parseTrendyolTree(rawBytes.toString("utf8"));
const baseline = parseBaseline(readFileSync(baselinePath, "utf8"));
const { rows, summary } = planTree(nodes, baseline);

const files = {
  migration: renderMigration(sha, rows, summary),
  csv: renderCsv(rows),
  rollback: renderRollback(summary),
};

console.log(`taban ${baseline.length} kategori, Trendyol ${nodes.length} (sha256 ${sha})`);
console.log(
  `plan: toplam ${summary.total}, eslesen ${summary.matched}, olusturulan ${summary.created}, ` +
    `kok ${summary.roots} (yeni ${summary.newRoots}), azami derinlik ${summary.maxDepth}`,
);
console.log("yol derinligi dagilimi", JSON.stringify(summary.perDepth));
console.log(`sonek eklenen: yol ${summary.pathSuffixed}, slug ${summary.slugSuffixed}`);

if (process.argv.includes("--generate")) {
  for (const key of Object.keys(files) as (keyof typeof files)[]) {
    writeFileSync(outputs[key], files[key]);
    console.log(`yazildi: ${outputs[key]}`);
  }
} else if (process.argv.includes("--check")) {
  const stale = (Object.keys(files) as (keyof typeof files)[]).filter(
    (key) => read(outputs[key]) !== files[key],
  );
  if (stale.length > 0) {
    console.error(`plan ile uyumsuz (--generate calistirin): ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log("migration, CSV ve geri alma betigi plan ile uyumlu");
}
