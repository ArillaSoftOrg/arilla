/**
 * IntentV2 arama olcumu: (a) deterministik vs (b) oracle niyet, dev seti
 * (docs/decisions/0171 §10). Model cagrisi yok.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:PORT/db \
 *     node scripts/eval-intent-v2-search.ts [--scope all|bootstrap|merchants:1,2] [--json out.json]
 *
 * Yalnizca yerel veritabani: `resolveQuery` `query_resolution`'a yazar.
 * Urun alakalilik etiketi olmadigi icin bulma basarisi/nDCG raporlanmaz.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import type { IntentV2Dataset } from "../src/eval/intent-v2-eval.ts";
import { summarizeIntentSearch } from "../src/eval/intent-v2-search.ts";
import { parseSearchEvalScope } from "../src/eval/search-eval.ts";
import { catalogSummary, scopeMerchantIds } from "../src/search/eval/run-eval.ts";
import { evaluateIntentSearch } from "../src/search/eval/run-intent-v2-search.ts";

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error("DATABASE_URL yerel degil; olcum yalnizca yerel veritabaninda calisir.");
  process.exit(2);
}
const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const scope = parseSearchEvalScope(argValue("--scope") ?? "all");
if (scope === null) {
  console.error("kullanim: --scope bootstrap|all|merchants:1,2,3");
  process.exit(2);
}

const dataset = JSON.parse(
  readFileSync(new URL("../src/eval/datasets/intent-v2.dev.json", import.meta.url), "utf8"),
) as IntentV2Dataset;

const db = createDatabase(url);
const merchantIds = await scopeMerchantIds(db, scope);
const catalog = await catalogSummary(db, merchantIds);
const started = performance.now();
const rows = await evaluateIntentSearch(db, dataset.cases, merchantIds);
const s = summarizeIntentSearch(rows);
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

console.log(
  `katalog: ${catalog.products} urun, ${catalog.activeOffers} teklif, parmak izi ${catalog.fingerprint.slice(0, 12)} | etiket: ${dataset.label_source}`,
);
console.log(
  `vaka ${s.cases} | plan uygulandi ${s.planApplied} | sure ${Math.round(performance.now() - started)} ms`,
);
console.log(`sifir sonuc        a ${s.zeroA}  b ${s.zeroB}`);
console.log(
  `butce ihlali       a ${s.budgetViolatedA}/${s.budgetCases}  b ${s.budgetViolatedB}/${s.budgetCases}`,
);
console.log(
  `haric ilk 10'da    a ${s.excludedHitA}/${s.excludedCases}  b ${s.excludedHitB}/${s.excludedCases}`,
);
console.log(
  `uyum kademe-1      a ${s.compatTier1A}  b ${s.compatTier1B}  (${s.compatCases} vaka, ilk 10 toplam)`,
);
console.log(
  `ilk 10 ayni ${s.identicalTop10}/${s.cases} (${pct(s.identicalTop10, s.cases)}) | ort. kesisim ${s.meanOverlap10.toFixed(2)}`,
);
console.log(`(a) dolu, (b) bos: ${s.bEmptiedA.length === 0 ? "yok" : s.bEmptiedA.join(", ")}`);
console.log("bulma basarisi / nDCG: urun alakalilik etiketi bekliyor (hesaplanmadi)");

const out = argValue("--json");
if (out) {
  writeFileSync(out, `${JSON.stringify({ catalog, summary: s, rows }, null, 2)}\n`);
}
process.exit(0);
