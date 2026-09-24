/**
 * Metin arama degerlendirmesi (docs/decisions/0029).
 *
 *   DATABASE_URL=postgresql://arilla_app:...@localhost:5432/arilla \
 *     node scripts/search-eval.ts [--json cikti.json]
 *
 * Yalnizca yerel veritabani: bootstrap katalogu (0027) yalnizca orada var.
 * Sorgu cozumlemesi `query_resolution` onbellegine yazar; bu yuzden uzak bir
 * veritabanina karsi calismaz.
 */
import { writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import { evaluateAll } from "../src/search/eval/run-eval.ts";

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  // Degeri yazdirma: parola icerir.
  console.error("DATABASE_URL yerel degil; degerlendirme yalnizca yerel veritabaninda calisir.");
  process.exit(2);
}

const db = createDatabase(url);
const started = performance.now();
const rows = await evaluateAll(db);
const elapsed = performance.now() - started;

const pad = (value: unknown, width: number) => String(value).padEnd(width).slice(0, width);
console.log(
  `${pad("grup", 15)}${pad("sorgu", 22)}${pad("don", 5)}${pad("@5", 4)}${pad("@10", 5)}${pad("ilk", 5)}${pad("katalog", 8)}yanlis-pozitif (ilk 10)`,
);
for (const row of rows) {
  const first =
    row.zeroResultCorrect === null
      ? (row.firstRelevant ?? "-")
      : row.zeroResultCorrect
        ? "0 ✓"
        : "✗";
  console.log(
    `${pad(row.group, 15)}${pad(row.q, 22)}${pad(row.returned, 5)}${pad(row.relevantAt5, 4)}${pad(row.relevantAt10, 5)}${pad(first, 5)}${pad(row.relevantInCatalog, 8)}${row.falsePositives.slice(0, 2).join(" | ")}`,
  );
}
const scored = rows.filter((row) => row.zeroResultCorrect === null);
const absent = rows.filter((row) => row.zeroResultCorrect !== null);
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);
console.log(
  `\nortalama ilgili@5 ${mean(scored.map((r) => r.relevantAt5)).toFixed(2)} | ilgili@10 ${mean(scored.map((r) => r.relevantAt10)).toFixed(2)} | ilk 10'da yanlis pozitif ${scored.reduce((n, r) => n + r.falsePositives.length, 0)} | yok-sorgusu dogru ${absent.filter((r) => r.zeroResultCorrect).length}/${absent.length} | ${elapsed.toFixed(0)} ms`,
);

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
  writeFileSync(process.argv[jsonIndex + 1] as string, JSON.stringify(rows, null, 2));
}
process.exit(0);
