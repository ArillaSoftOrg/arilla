/**
 * Sorgu normalizasyonu degerlendirmesi (karar 0172). DB, ag ve model yok.
 *
 *   node packages/core/scripts/eval-normalization.ts --split dev [--verbose]
 *   node packages/core/scripts/eval-normalization.ts --split holdout --final
 *
 * Dogrulama kumesi (`holdout`) gelistirme sirasinda KOSULMAZ: yalniz entegre son
 * degerlendirmede (Faz 3) `--final` ile bir kez. Dosyanin SHA-256'si karar 0172'deki degerle
 * eslesmezse kosu reddedilir (kume degistirilmis).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateNormalization, type NormalizationCase } from "../src/search/spelling/evaluate.ts";
import { buildVocabulary } from "../src/search/spelling/vocabulary.ts";

const HOLDOUT_SHA256 = "760537e6d436d563585907029ba23bb087f2a540fd797a77221a524aa87a183b";

const here = dirname(fileURLToPath(import.meta.url));
const datasets = join(here, "..", "src", "eval", "datasets");
const args = process.argv.slice(2);
const split = args[args.indexOf("--split") + 1] ?? "dev";
const verbose = args.includes("--verbose");

if (split !== "dev" && split !== "holdout") {
  console.error("--split dev | holdout");
  process.exit(2);
}
const datasetPath = join(datasets, `query-normalization.${split}.json`);
const datasetText = readFileSync(datasetPath, "utf8");
if (split === "holdout") {
  if (!args.includes("--final")) {
    console.error(
      "Dogrulama kumesi gelistirme sirasinda kosulmaz (karar 0172). Yalniz son degerlendirmede --final ile.",
    );
    process.exit(2);
  }
  const digest = createHash("sha256").update(readFileSync(datasetPath)).digest("hex");
  if (digest !== HOLDOUT_SHA256) {
    console.error(`Dogrulama kumesi degismis: ${digest} != ${HOLDOUT_SHA256}`);
    process.exit(2);
  }
}

const fixture = JSON.parse(
  readFileSync(join(here, "..", "src", "search", "spelling", "vocabulary.fixture.json"), "utf8"),
) as { categories: string[]; lexicon: { surface: string }[] };
const { brands } = JSON.parse(
  readFileSync(join(datasets, "query-normalization.brands.json"), "utf8"),
) as { brands: string[] };
const vocabulary = buildVocabulary({
  categories: fixture.categories,
  lexicon: fixture.lexicon,
  brands,
});
const { cases } = JSON.parse(datasetText) as { cases: NormalizationCase[] };
const report = evaluateNormalization(cases, vocabulary, brands, { repeats: 20 });

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
console.log(
  `split=${split} cases=${report.cases} vocabulary=${vocabulary.size} (${vocabulary.version})`,
);
console.log(
  `normalizasyon dogrulugu   ${pct(report.normalizationAccuracy)} (${report.expectedCases} vaka)`,
);
console.log(`yanlis duzeltme (genel)   ${pct(report.wrongCorrectionRate)}`);
console.log(`yanlis duzeltme (no_corr) ${pct(report.noCorrectWrongRate)}`);
console.log(`degismeme (dogru yazilmis) ${pct(report.unchangedRate)}`);
console.log(`kod korunmasi             ${pct(report.codePreservation)}`);
console.log(`marka korunmasi           ${pct(report.brandPreservation)}`);
console.log(
  `gecikme p50/p95           ${report.latencyP50Ms.toFixed(3)} / ${report.latencyP95Ms.toFixed(3)} ms`,
);
console.log("kategori                  dogru/vaka  yanlis");
for (const [category, bucket] of Object.entries(report.byCategory)) {
  console.log(
    `  ${category.padEnd(22)} ${String(bucket.correct).padStart(3)}/${String(bucket.cases).padEnd(4)}   ${bucket.wrong}`,
  );
}
const failures = report.outcomes.filter((o) => !o.correct);
if (verbose || split === "dev") {
  for (const o of failures) {
    console.log(
      `  x ${o.id} [${o.category}] "${o.query}" -> "${o.corrected}"` +
        `${o.missed.length ? ` eksik=${o.missed.join(",")}` : ""}` +
        `${o.wrong.length ? ` yanlis=${o.wrong.join(",")}` : ""}` +
        `${o.inAlternatives.length ? ` alternatifte=${o.inAlternatives.join(",")}` : ""}`,
    );
  }
}
