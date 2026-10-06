#!/usr/bin/env node
/**
 * docs/decisions altinda her karar numarasi YALNIZCA BIR karar icin kullanilir.
 * Salt okunur, agsiz, veritabansiz. `node scripts/check-adr-numbers.mjs`
 *
 * Migration dosya adlariyla (`packages/db/migrations/NNNN_*.sql`, defter
 * kimligi) KARISTIRILMAZ: iki numara uzayi bagimsizdir. Bir karar numarasi
 * migration yorumlarinda anilabilir; bu betik yalniz `docs/decisions`e bakar.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "decisions");
const byNumber = new Map();
const malformed = [];

for (const name of readdirSync(dir)) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  const match = /^(\d{4})-[a-z0-9-]+\.md$/.exec(name);
  if (!match) {
    malformed.push(name);
    continue;
  }
  byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), name]);
}

const problems = [];
for (const [number, names] of byNumber) {
  if (names.length > 1) problems.push(`${number} birden fazla kararda: ${names.join(", ")}`);
}
for (const name of malformed)
  problems.push(`ad bicimi gecersiz (NNNN-kisa-ad.md beklenir): ${name}`);

if (problems.length > 0) {
  console.error("ADR numara denetimi BASARISIZ:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `ADR numara denetimi tamam: ${[...byNumber.values()].flat().length} karar, numaralar benzersiz.`,
);
