/**
 * Migration dosya adlarini denetler (salt okunur, veritabani yok).
 *
 * Calistirici kimligi dosya adinin TAMAMIDIR (`schema_migration.filename`), bu
 * yuzden ayni numarali iki dosya teknik olarak calisir — ama gecmiste iki farkli
 * "0050" birakmak okunurlugu ve siralamayi (alfabetik) tesadufe baglar
 * (docs/decisions/0066). Kural: her numara bir kez.
 *
 * Yeni bir ortamin siralamasi bu dosyalarin adina gore deterministiktir; bu
 * denetim bosluk (kullanilmayan numara) yasaklamaz — yalnizca tekrar ve ad
 * bicimi.
 */
import { readdirSync } from "node:fs";
import { migrationsDir } from "./lib.ts";

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const problems: string[] = [];
const byNumber = new Map<string, string[]>();

for (const file of files) {
  const match = NAME.exec(file);
  if (!match || match[1] === undefined) {
    problems.push(`ad bicimi gecersiz (NNNN_kisa_ad.sql beklenir): ${file}`);
    continue;
  }
  const group = byNumber.get(match[1]) ?? [];
  group.push(file);
  byNumber.set(match[1], group);
}

for (const [number, group] of byNumber) {
  if (group.length > 1) {
    problems.push(`${number} numarasi ${group.length} dosyada: ${group.join(", ")}`);
  }
}

if (problems.length > 0) {
  console.error("Migration denetimi BASARISIZ:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Migration denetimi tamam: ${files.length} dosya, tekrarlayan numara yok.`);
