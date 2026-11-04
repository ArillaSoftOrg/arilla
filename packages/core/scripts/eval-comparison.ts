/**
 * Turkce referansli karsilastirma sorgulari: bugunku ayristirici davranisi
 * (plan T2; `src/eval/comparison-eval.ts`).
 *
 *   node --experimental-transform-types scripts/eval-comparison.ts [--json cikti.json]
 *
 * Veritabani ve model cagrisi yok. Sozluk varsayimi `eval:intent-v2` ile ayni:
 * siniflandirma fixture'i (kategori + es anlam) + setin `lexicon_brands`
 * listesi. Uretim sozlugu farklidir (2026-11-04: uretimde marka kaydi yok);
 * bu olcum ayristiricinin davranisini, uretim kapsamini degil, gosterir.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  type ComparisonDataset,
  scoreComparisonCase,
  summarizeComparison,
} from "../src/eval/comparison-eval.ts";
import dataset from "../src/eval/datasets/comparison-queries.dev.json" with { type: "json" };
import { brandEntries } from "../src/eval/intent-v2-eval.ts";
import type { LexiconEntry } from "../src/search/lexicon.ts";
import { parseQueryText } from "../src/search/parse-query.ts";

const DATASET = dataset as unknown as ComparisonDataset;
const fixture = JSON.parse(
  readFileSync(
    new URL("../src/search/classification-lexicon.fixture.json", import.meta.url),
    "utf8",
  ),
) as LexiconEntry[];
const lexicon = [...fixture, ...brandEntries(DATASET.lexicon_brands)];

const results = DATASET.cases.map((testCase) =>
  scoreComparisonCase(testCase, parseQueryText(testCase.q, lexicon)),
);
const summary = summarizeComparison(DATASET.cases, results);

const pad = (value: unknown, width: number) => String(value).padEnd(width).slice(0, width);
const flag = (value: boolean | null) => (value === null ? "-" : value ? "evet" : "hayır");
console.log(
  `${pad("id", 5)}${pad("kategori", 17)}${pad("ref.marka filtre", 18)}${pad("dışlama", 9)}sızan işaret`,
);
for (const r of results) {
  console.log(
    `${pad(r.id, 5)}${pad(r.cat, 17)}${pad(flag(r.anchorBrandAsFilter), 18)}${pad(flag(r.exclusionsKept), 9)}${r.markersLeaked.join(", ")}`,
  );
}
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
console.log(
  [
    "",
    `vaka ${summary.cases} (ilişkili ${summary.relationCases}, kontrol ${summary.controlCases}); etiketler: ${DATASET.label_source}`,
    `referans markası zorunlu filtre oldu   ${pct(summary.anchorBrandAsFilterRate)}  (hedef 0)`,
    `karşılaştırma sözcüğü aramaya sızdı    ${pct(summary.markerLeakRate)}  (hedef 0)`,
    `ilişki tanındı                         ${pct(summary.relationRecognizedRate)}  (hedef 100)`,
    `açık dışlama korundu                   ${pct(summary.exclusionKeptRate)}  (hedef 100)`,
    `kontrol: marka filtresi korundu        ${pct(summary.controlBrandKeptRate)}  (hedef 100)`,
    `kontrol: yanlış ilişki                 ${pct(summary.controlFalseRelationRate)}  (hedef 0)`,
    `kontrol: tercih sözcüğü aramaya sızdı  ${pct(summary.controlMarkerLeakRate)}  (hedef 0)`,
  ].join("\n"),
);

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
  writeFileSync(
    process.argv[jsonIndex + 1] as string,
    JSON.stringify({ summary, results }, null, 2),
  );
}
