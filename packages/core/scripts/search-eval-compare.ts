/**
 * Iki arama degerlendirme kosusunu cevrimdisi karsilastirir (Faz 1A).
 *
 *   node scripts/search-eval-compare.ts temel.json yeni.json [--tolerance 0.01]
 *     [--require-identical]
 *
 * Girdiler `search-eval.ts --json` ciktisidir: v2 zarfi (`{ meta, rows }`) ya da
 * eski v1 satir dizisi. Veritabani gerekmez.
 *
 * - Metrik karsilastirmasi her iki bicimde calisir; regresyon varsa cikis kodu 1.
 * - Iki dosya da v2 ise ilk 10 urun kimligi sorgu bazinda karsilastirilir (0171 G6)
 *   ve katalog parmak izi, kapsam ve sorgu seti esitligi denetlenir.
 * - `--require-identical`: kosular karsilastirilamazsa ya da bir sorgunun ilk 10
 *   listesi (sira dahil) farkliysa cikis kodu 1 ("bayrak kapali birebir" denetimi).
 */
import { readFileSync } from "node:fs";
import {
  comparabilityIssues,
  compareRunIds,
  compareSearch,
  parseSearchEvalFile,
  summarizeSearch,
} from "../src/eval/search-eval.ts";

const [basePath, currentPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!basePath || !currentPath) {
  console.error("kullanim: search-eval-compare.ts temel.json yeni.json [--tolerance 0.01]");
  process.exit(2);
}
const toleranceIndex = process.argv.indexOf("--tolerance");
const tolerance = toleranceIndex === -1 ? 0.01 : Number(process.argv[toleranceIndex + 1]);

const requireIdentical = process.argv.includes("--require-identical");

const load = (path: string) => parseSearchEvalFile(JSON.parse(readFileSync(path, "utf8")));
const baseRun = load(basePath);
const currentRun = load(currentPath);
const changes = compareSearch(
  summarizeSearch(baseRun.rows),
  summarizeSearch(currentRun.rows),
  tolerance,
);
for (const c of changes) {
  const flag = c.regressed ? "REGRESYON" : "ok       ";
  console.log(`${flag} ${c.metric.padEnd(20)} ${c.baseline.toFixed(3)} -> ${c.current.toFixed(3)}`);
}
let failed = changes.some((c) => c.regressed);

const issues = comparabilityIssues(baseRun.meta, currentRun.meta);
for (const issue of issues) console.log(`UYARI     karşılaştırılabilirlik: ${issue}`);

if (baseRun.meta !== null && currentRun.meta !== null) {
  const ids = compareRunIds(baseRun.rows, currentRun.rows);
  console.log(
    `\nürün kimliği: ${ids.identical}/${ids.compared} sorguda ilk 10 birebir aynı | ortalama örtüşme ${ids.meanOverlapAt10.toFixed(3)}`,
  );
  for (const d of ids.diffs.filter((x) => !x.identical)) {
    const stage =
      d.baseStage === d.currentStage ? "" : ` | aşama ${d.baseStage} -> ${d.currentStage}`;
    console.log(
      `FARK      ${d.q.padEnd(24)} ortak ${d.overlap} | +${d.added.length} -${d.removed.length}${stage}`,
    );
  }
  if (ids.unmatched.length > 0) {
    console.log(`eşleşmeyen sorgu: ${ids.unmatched.join(", ")}`);
  }
  if (requireIdentical && (ids.identical !== ids.compared || ids.unmatched.length > 0)) {
    failed = true;
  }
}
if (requireIdentical && issues.length > 0) failed = true;
process.exit(failed ? 1 : 0);
