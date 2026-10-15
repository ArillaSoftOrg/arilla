/**
 * Migration klasorunu guvenlik kurallarina gore denetler (karar 0111).
 * Veritabanina baglanmaz. CI'da `pnpm db:lint-migrations`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir } from "./lib.ts";
import { lintMigrations } from "./migration-lint.ts";

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }));

const issues = lintMigrations(files);
for (const issue of issues) {
  console.error(`  HATA ${issue.file} [${issue.rule}]: ${issue.message}`);
}
if (issues.length > 0) {
  console.error(`${issues.length} sorun.`);
  process.exit(1);
}
console.log(`${files.length} migration dosyasi kurallara uygun.`);
