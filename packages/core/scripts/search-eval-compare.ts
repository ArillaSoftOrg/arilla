/**
 * Iki arama degerlendirme kosusunu cevrimdisi karsilastirir (Faz 1A).
 *
 *   node scripts/search-eval-compare.ts temel.json yeni.json [--tolerance 0.01]
 *
 * Girdiler `search-eval.ts --json` ciktisidir (EvalRow[]). Veritabani gerekmez.
 * Regresyon varsa cikis kodu 1.
 */
import { readFileSync } from "node:fs";
import { compareSearch, summarizeSearch } from "../src/eval/search-eval.ts";

const [basePath, currentPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!basePath || !currentPath) {
  console.error("kullanim: search-eval-compare.ts temel.json yeni.json [--tolerance 0.01]");
  process.exit(2);
}
const toleranceIndex = process.argv.indexOf("--tolerance");
const tolerance = toleranceIndex === -1 ? 0.01 : Number(process.argv[toleranceIndex + 1]);

const load = (path: string) => summarizeSearch(JSON.parse(readFileSync(path, "utf8")));
const base = load(basePath);
const current = load(currentPath);
const changes = compareSearch(base, current, tolerance);
for (const c of changes) {
  const flag = c.regressed ? "REGRESYON" : "ok       ";
  console.log(`${flag} ${c.metric.padEnd(20)} ${c.baseline.toFixed(3)} -> ${c.current.toFixed(3)}`);
}
process.exit(changes.some((c) => c.regressed) ? 1 : 0);
