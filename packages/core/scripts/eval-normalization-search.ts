/**
 * Normalizasyonun arama sonuclarina etkisi (karar 0172, Faz 2). Yalniz YEREL veritabani.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:PORT/arilla node scripts/eval-normalization-search.ts
 *
 * Etiketsiz, karsilastirmali olcum (ayni veritabani, ayni kod; yalniz bayrak farkli):
 * - Hatali yazilmis gelistirme sorgulari: sifir sonuc orani ve DOGRU YAZILMIS esdeger sorgunun
 *   (bayrak kapali) ilk 10'uyla ortusme, bayrak kapali vs acik. Esdeger sorgu, veri kumesindeki
 *   beklenen duzeltmelerle uretilir; dogru urunun ne oldugunu soylemez, "duzeltilmis sorgunun
 *   sonucuna ne kadar yaklasildi" sorusunu olcer.
 * - Duzeltme beklemeyen gelistirme sorgulari ve 38'lik `bootstrap-queries.json`: ilk 10'u
 *   degisen sorgu orani (hedef ~0).
 *
 * Yalniz okur: ayristirma `parseQueryText` ile yapilir (`query_resolution`'a yazilmaz).
 * Dogrulama kumesi (holdout) burada KULLANILMAZ.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@arilla/db";
import { createSeedAliasSource } from "../src/search/fallback/aliases.ts";
import { searchWithFallback } from "../src/search/fallback/pipeline.ts";
import { createPostgresSearchProvider } from "../src/search/fallback/postgres-provider.ts";
import { loadLexicon } from "../src/search/lexicon-repository.ts";
import { parseQueryText } from "../src/search/parse-query.ts";
import { normalizeParsedForSearch } from "../src/search/spelling/apply.ts";
import type { NormalizationCase } from "../src/search/spelling/evaluate.ts";
import { loadVocabulary } from "../src/search/spelling/vocabulary-repository.ts";

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error("DATABASE_URL yerel degil; degerlendirme yalnizca yerel veritabaninda calisir.");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const db = createDatabase(url);
const lexicon = await loadLexicon(db);
const vocabulary = await loadVocabulary(db);
const provider = createPostgresSearchProvider(db, { statementTimeoutMs: 5_000 });
const aliases = createSeedAliasSource();

interface Run {
  ids: number[];
  results: boolean;
}

async function run(query: string, mode: "off" | "on"): Promise<Run> {
  const parsed = parseQueryText(query, lexicon);
  const searchParsed = await normalizeParsedForSearch(db, parsed, {
    mode,
    log: () => {},
    loadVocabulary: async () => vocabulary,
    loadLexicon: async () => lexicon,
  });
  const outcome = await searchWithFallback(
    provider,
    { parsed: { ...searchParsed, sort: "balanced" }, sort: "balanced", page: 1, pageSize: 24 },
    { aliases },
  );
  return {
    ids: outcome.items.slice(0, 10).map((item) => item.productId),
    results: outcome.mode === "results" && outcome.items.length > 0,
  };
}

function overlap(a: readonly number[], reference: readonly number[]): number {
  if (reference.length === 0) return a.length === 0 ? 1 : 0;
  const set = new Set(reference);
  return a.filter((id) => set.has(id)).length / reference.length;
}

function referenceQuery(item: NormalizationCase): string {
  let text = item.query;
  for (const [from, targets] of Object.entries(item.expect)) {
    text = text.replace(from, targets[0] as string);
  }
  return text;
}

const { cases } = JSON.parse(
  readFileSync(join(here, "..", "src", "eval", "datasets", "query-normalization.dev.json"), "utf8"),
) as { cases: NormalizationCase[] };
const bootstrap = (
  JSON.parse(
    readFileSync(join(here, "..", "src", "search", "eval", "bootstrap-queries.json"), "utf8"),
  ) as { queries: { q: string }[] }
).queries.map((row) => row.q);

const misspelled = cases.filter((c) => Object.keys(c.expect).length > 0);
const correct = cases.filter((c) => Object.keys(c.expect).length === 0).map((c) => c.query);

let zeroOff = 0;
let zeroOn = 0;
let overlapOff = 0;
let overlapOn = 0;
let referenceEmpty = 0;
// Esdeger (dogru yazilmis) sorgusu sonuc veren vakalar: katalogda karsiligi olan, kurtarilabilir.
let recoverable = 0;
let recoverableZeroOff = 0;
let recoverableZeroOn = 0;
const rows: string[] = [];
for (const item of misspelled) {
  const reference = await run(referenceQuery(item), "off");
  const off = await run(item.query, "off");
  const on = await run(item.query, "on");
  if (!off.results) zeroOff += 1;
  if (!on.results) zeroOn += 1;
  if (!reference.results) referenceEmpty += 1;
  else {
    recoverable += 1;
    if (!off.results) recoverableZeroOff += 1;
    if (!on.results) recoverableZeroOn += 1;
  }
  const o1 = overlap(off.ids, reference.ids);
  const o2 = overlap(on.ids, reference.ids);
  overlapOff += o1;
  overlapOn += o2;
  rows.push(
    `  ${item.id} ${item.query.padEnd(32)} sonuc ${off.results ? "+" : "-"}/${on.results ? "+" : "-"}  ortusme ${o1.toFixed(2)} -> ${o2.toFixed(2)}${reference.results ? "" : "  (esdeger sorgu da bos)"}`,
  );
}

async function changedTop10(queries: readonly string[]): Promise<string[]> {
  const changed: string[] = [];
  for (const query of queries) {
    const off = await run(query, "off");
    const on = await run(query, "on");
    if (off.ids.join(",") !== on.ids.join(",")) changed.push(query);
  }
  return changed;
}

const changedCorrect = await changedTop10(correct);
const changedBootstrap = await changedTop10(bootstrap);

const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
console.log(`katalog: yerel; dagarcik ${vocabulary.size} kelime (${vocabulary.version})`);
console.log(`hatali yazilmis (${misspelled.length}):`);
console.log(
  `  sifir sonuc            kapali ${pct(zeroOff, misspelled.length)}  acik ${pct(zeroOn, misspelled.length)}`,
);
console.log(
  `  sifir sonuc (esdegeri sonuc veren ${recoverable})  kapali ${pct(recoverableZeroOff, recoverable)}  acik ${pct(recoverableZeroOn, recoverable)}`,
);
console.log(
  `  esdegerle ortusme@10   kapali ${(overlapOff / misspelled.length).toFixed(3)}  acik ${(overlapOn / misspelled.length).toFixed(3)}  (esdeger bos: ${referenceEmpty})`,
);
console.log(
  `dogru yazilmis (${correct.length}): ilk 10'u degisen ${changedCorrect.length} ${changedCorrect.join(" | ")}`,
);
console.log(
  `bootstrap (${bootstrap.length}): ilk 10'u degisen ${changedBootstrap.length} ${changedBootstrap.join(" | ")}`,
);
if (process.argv.includes("--verbose")) for (const row of rows) console.log(row);
process.exit(0);
