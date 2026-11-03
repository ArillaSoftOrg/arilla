/**
 * IntentV2 niyet katmani degerlendirmesi (karar 0171 §10). Ag, DB, model yok.
 *
 *   node scripts/eval-intent-v2.ts                       # yerel temel (kosul a), dev seti
 *   node scripts/eval-intent-v2.ts --predictions p.json  # ham model ciktilari {id: raw} (Faz 1B)
 *   node scripts/eval-intent-v2.ts --json out.json
 *   node scripts/eval-intent-v2.ts --holdout-final       # YALNIZCA Faz 3, bir kez
 *
 * `--predictions` dosyasi baska bir adimda (ayri onayla) uretilir; bu betik
 * hicbir saglayiciyi cagirmaz.
 *
 * Sozluk varsayimi: siniflandirma fixture'i (kategori + es anlam) + setin
 * `lexicon_brands` listesi. Uretim sozlugu farklidir; marka kapsami burada
 * IYIMSERDIR (setteki her marka sozlukte varsayilir).
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  brandEntries,
  type IntentV2Dataset,
  predictFromLocal,
  predictFromValidated,
  scoreCase,
  summarize,
  summarizeBy,
} from "../src/eval/intent-v2-eval.ts";
import { fromRawQuery } from "../src/intent/normalized-query-adapter.ts";
import { validateIntentV2 } from "../src/intent/validate.ts";
import type { LexiconEntry } from "../src/search/lexicon.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};

const datasetPath = flag("--holdout-final")
  ? new URL("../src/eval/datasets/intent-v2.holdout.json", import.meta.url)
  : new URL("../src/eval/datasets/intent-v2.dev.json", import.meta.url);
const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as IntentV2Dataset;
if (dataset.cases.length === 0) {
  console.error("Veri setinde vaka yok.");
  process.exit(2);
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../src/search/classification-lexicon.fixture.json", import.meta.url),
    "utf8",
  ),
) as LexiconEntry[];
const lexicon = [...fixture, ...brandEntries(dataset.lexicon_brands ?? [])];

const predictionsPath = value("--predictions");
const predictions = predictionsPath
  ? (JSON.parse(readFileSync(predictionsPath, "utf8")) as Record<string, unknown>)
  : null;

const rows = dataset.cases.map((testCase) => {
  if (predictions === null) return scoreCase(testCase, predictFromLocal(testCase.q, lexicon));
  const validated = validateIntentV2(predictions[testCase.id] ?? null, {
    query: fromRawQuery(testCase.q),
    lexicon,
  });
  return scoreCase(testCase, predictFromValidated(validated));
});

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const line = (label: string, s: ReturnType<typeof summarize>) =>
  `${label.padEnd(12)} n=${String(s.cases).padStart(3)} tur ${pct(s.typeAccuracy)} rol ${pct(s.roleAccuracy)} uyum ${pct(s.compatAccuracy)} marka ${pct(s.brandAccuracy)} butce ${pct(s.budgetAccuracy)} oz P/R ${pct(s.attrPrecision)}/${pct(s.attrRecall)} | yanlis-H ${pct(s.falseHardFilterRate)} koruma ${pct(s.intentPreservation)} ters ${s.reversedCases}`;

const summary = summarize(rows);
console.log(
  `kaynak: ${predictions ? `model (${predictionsPath})` : "yerel deterministik (kosul a)"} | etiket: ${dataset.label_source}`,
);
console.log(line("TOPLAM", summary));
for (const [k, s] of Object.entries(summarizeBy(rows, (r) => r.cat))) console.log(line(k, s));
for (const [k, s] of Object.entries(summarizeBy(rows, (r) => r.lang)))
  console.log(line(`dil:${k}`, s));
for (const [k, s] of Object.entries(
  summarizeBy(rows, (r) => (r.typo ? "yazim-hatali" : "duzgun")),
)) {
  console.log(line(k, s));
}
console.log(`yargilanamayan sert filtre: ${summary.unjudgedHardFilters}`);
for (const row of rows.filter((r) => r.falseHard.length > 0 || r.reversed.length > 0)) {
  console.log(
    `  ${row.id} "${row.q}" yanlis-H=[${row.falseHard.join(", ")}] ters=[${row.reversed.join(", ")}] eksik=[${row.missing.join(", ")}]`,
  );
}

const jsonPath = value("--json");
if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 2));
