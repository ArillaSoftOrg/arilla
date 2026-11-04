/**
 * Glossary (TR -> EN) koprusunun arama etkisi, YALNIZ gelistirme kumesinde (karar 0172, Faz 3).
 * Yalniz YEREL veritabani; veritabanina hicbir sey yazilmaz.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:PORT/arilla \
 *     node scripts/eval-glossary-filter.ts --candidates candidates.json [--verbose]
 *
 * Aday `lexicon(kind='synonym')` satirlari (glossary prototipinin ciktisi; Python tarafinda
 * uretilir) BELLEKTE mevcut sozluge eklenir; ayristirma, dagarcik ve normalizasyon bu genisletilmis
 * sozlukle calisir. Her yapilandirma ayni veritabani ve ayni kodla olculur.
 *
 * Yargi: `query-normalization.dev.relevance.json` (baslik desenleri, glossary'den bagimsiz).
 * Olcutler: P@10, basari@10 (ilk 10'da en az bir ilgili), sifir sonuc; katalogda ilgili urunu
 * olan ("kurtarilabilir") vakalar ayrica. 38'lik bootstrap setinde ilk 10'u degisen sorgu sayisi.
 * Dogrulama kumesi (holdout) burada KULLANILMAZ.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand, category, createDatabase, product } from "@arilla/db";
import { exists, sql } from "drizzle-orm";
import { createSeedAliasSource } from "../src/search/fallback/aliases.ts";
import { searchWithFallback } from "../src/search/fallback/pipeline.ts";
import { createPostgresSearchProvider } from "../src/search/fallback/postgres-provider.ts";
import type { LexiconEntry } from "../src/search/lexicon.ts";
import { loadLexicon } from "../src/search/lexicon-repository.ts";
import { parseQueryText } from "../src/search/parse-query.ts";
import { normalizeParsedForSearch } from "../src/search/spelling/apply.ts";
import { buildVocabulary, type Vocabulary } from "../src/search/spelling/vocabulary.ts";
import { VOCABULARY_BRAND_LIMIT } from "../src/search/spelling/vocabulary-repository.ts";

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
const candidatesArg = process.argv.indexOf("--candidates");
const candidatesPath = candidatesArg > 0 ? process.argv[candidatesArg + 1] : undefined;
if (!candidatesPath) {
  console.error("--candidates <dosya.json> gerekli");
  process.exit(2);
}
const verbose = process.argv.includes("--verbose");

const here = dirname(fileURLToPath(import.meta.url));
const datasets = join(here, "..", "src", "eval", "datasets");
const db = createDatabase(url);
const provider = createPostgresSearchProvider(db, { statementTimeoutMs: 5_000 });
const aliases = createSeedAliasSource();

interface Judgment {
  all: string[];
  none?: string[];
}
const dev = (
  JSON.parse(readFileSync(join(datasets, "query-normalization.dev.json"), "utf8")) as {
    cases: { id: string; query: string }[];
  }
).cases;
const judgments = (
  JSON.parse(readFileSync(join(datasets, "query-normalization.dev.relevance.json"), "utf8")) as {
    cases: Record<string, Judgment>;
  }
).cases;
const bootstrap = (
  JSON.parse(
    readFileSync(join(here, "..", "src", "search", "eval", "bootstrap-queries.json"), "utf8"),
  ) as { queries: { q: string }[] }
).queries.map((row) => row.q);
const candidates = JSON.parse(readFileSync(candidatesPath, "utf8")) as {
  configs: Record<string, { entries: LexiconEntry[]; stats: Record<string, number> }>;
};

const [categoryRows, brandRows, baseLexicon] = await Promise.all([
  db.select({ name: category.name }).from(category),
  db
    .select({ name: brand.name })
    .from(brand)
    .where(
      exists(db.select({ one: sql`1` }).from(product).where(sql`${product.brandId} = ${brand.id}`)),
    )
    .limit(VOCABULARY_BRAND_LIMIT),
  loadLexicon(db),
]);

function judgeSql(judgment: Judgment) {
  const all = judgment.all.map((pattern) => sql`p.title ~* ${pattern}`);
  const none = (judgment.none ?? []).map((pattern) => sql`NOT (p.title ~* ${pattern})`);
  return sql.join([...all, ...none], sql` AND `);
}

async function relevantAmong(ids: readonly number[], judgment: Judgment): Promise<number> {
  if (ids.length === 0) return 0;
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM product p WHERE p.id IN (${list}) AND ${judgeSql(judgment)}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function catalogRelevant(judgment: Judgment): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM product p WHERE ${judgeSql(judgment)}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

interface Config {
  name: string;
  mode: "off" | "on";
  lexicon: LexiconEntry[];
  vocabulary: Vocabulary;
}

function config(name: string, mode: "off" | "on", extra: readonly LexiconEntry[]): Config {
  const lexicon = [...baseLexicon, ...extra];
  return {
    name,
    mode,
    lexicon,
    vocabulary: buildVocabulary({
      categories: categoryRows.map((row) => row.name),
      brands: brandRows.map((row) => row.name),
      lexicon,
    }),
  };
}

async function top10(query: string, cfg: Config): Promise<{ ids: number[]; slots: number }> {
  const parsed = parseQueryText(query, cfg.lexicon);
  const searchParsed = await normalizeParsedForSearch(db, parsed, {
    mode: cfg.mode,
    log: () => {},
    loadVocabulary: async () => cfg.vocabulary,
    loadLexicon: async () => cfg.lexicon,
  });
  const outcome = await searchWithFallback(
    provider,
    { parsed: { ...searchParsed, sort: "balanced" }, sort: "balanced", page: 1, pageSize: 24 },
    { aliases },
  );
  const items = outcome.mode === "results" ? outcome.items : [];
  const slots = (searchParsed.text_slots ?? []).reduce((sum, slot) => sum + slot.length, 0);
  return { ids: items.slice(0, 10).map((item) => item.productId), slots };
}

const configs: Config[] = [config("A norm=off", "off", []), config("B norm=on", "on", [])];
for (const [name, value] of Object.entries(candidates.configs)) {
  configs.push(config(`B+${name} (${value.entries.length})`, "on", value.entries));
}

const catalog = new Map<string, number>();
for (const item of dev) {
  const judgment = judgments[item.id];
  if (!judgment) throw new Error(`ilgililik yargisi yok: ${item.id}`);
  catalog.set(item.id, await catalogRelevant(judgment));
}
const recoverable = dev.filter((item) => (catalog.get(item.id) ?? 0) > 0);

interface Row {
  hits: number;
  results: number;
  slots: number;
  ids: number[];
}
const perConfig = new Map<string, Map<string, Row>>();
const bootstrapIds = new Map<string, string[]>();
for (const cfg of configs) {
  const rows = new Map<string, Row>();
  for (const item of dev) {
    const { ids, slots } = await top10(item.query, cfg);
    const judgment = judgments[item.id] as Judgment;
    rows.set(item.id, {
      hits: await relevantAmong(ids, judgment),
      results: ids.length,
      slots,
      ids,
    });
  }
  perConfig.set(cfg.name, rows);
  const ids: string[] = [];
  for (const query of bootstrap) ids.push((await top10(query, cfg)).ids.join(","));
  bootstrapIds.set(cfg.name, ids);
}

const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
function summary(rows: Map<string, Row>, cases: readonly { id: string }[]) {
  let precision = 0;
  let success = 0;
  let zero = 0;
  let slots = 0;
  for (const item of cases) {
    const row = rows.get(item.id) as Row;
    precision += row.hits / 10;
    if (row.hits > 0) success += 1;
    if (row.results === 0) zero += 1;
    slots += row.slots;
  }
  return {
    precision: (precision / Math.max(1, cases.length)).toFixed(3),
    success: pct(success, cases.length),
    zero: pct(zero, cases.length),
    slots: (slots / Math.max(1, cases.length)).toFixed(1),
  };
}

console.log(
  `katalog: yerel; dev ${dev.length} vaka, katalogda ilgilisi olan ${recoverable.length}; temel sozluk ${baseLexicon.length} satir`,
);
console.log(
  "yapilandirma".padEnd(26) +
    "| P@10 tum  basari tum  sifir tum | P@10 kurt  basari kurt | ort.alt | B'ye gore +/-  | bootstrap ilk10 degisen",
);
const reference = perConfig.get("B norm=on") as Map<string, Row>;
const referenceBoot = bootstrapIds.get("B norm=on") as string[];
for (const cfg of configs) {
  const rows = perConfig.get(cfg.name) as Map<string, Row>;
  const all = summary(rows, dev);
  const rec = summary(rows, recoverable);
  let better = 0;
  let worse = 0;
  for (const item of dev) {
    const delta = (rows.get(item.id) as Row).hits - (reference.get(item.id) as Row).hits;
    if (delta > 0) better += 1;
    if (delta < 0) worse += 1;
  }
  const boot = bootstrapIds.get(cfg.name) as string[];
  const changed = boot.filter((ids, index) => ids !== referenceBoot[index]).length;
  console.log(
    `${cfg.name.padEnd(26)}| ${all.precision.padStart(8)} ${all.success.padStart(11)} ${all.zero.padStart(10)} | ${rec.precision.padStart(9)} ${rec.success.padStart(12)} | ${all.slots.padStart(7)} | +${String(better).padEnd(3)} -${String(worse).padEnd(8)} | ${changed}/${bootstrap.length}`,
  );
}

if (verbose) {
  for (const cfg of configs.slice(2)) {
    const rows = perConfig.get(cfg.name) as Map<string, Row>;
    const boot = bootstrapIds.get(cfg.name) as string[];
    const changed = bootstrap.filter((_, index) => boot[index] !== referenceBoot[index]);
    console.log(`\n${cfg.name}: bootstrap ilk 10'u degisen: ${changed.join(" | ")}`);
    for (const [index, query] of bootstrap.entries()) {
      if (boot[index] === referenceBoot[index]) continue;
      for (const [label, ids] of [
        ["B", referenceBoot[index] as string],
        ["bu", boot[index] as string],
      ] as const) {
        const list = ids ? ids.split(",").map(Number).slice(0, 5) : [];
        const titles = list.length
          ? (
              await db.execute<{ title: string }>(
                sql`SELECT title FROM product WHERE id IN (${sql.join(
                  list.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
              )
            ).rows.map((row) => row.title.slice(0, 48))
          : [];
        console.log(`    ${query} [${label}] ${titles.join(" ; ") || "(bos)"}`);
      }
    }
    console.log(`${cfg.name}: B'ye gore degisen vakalar (isabet B -> bu)`);
    for (const item of dev) {
      const before = (reference.get(item.id) as Row).hits;
      const after = (rows.get(item.id) as Row).hits;
      if (before !== after) {
        console.log(
          `  ${item.id} ${item.query.padEnd(34)} ${before} -> ${after}  (katalog ${catalog.get(item.id)})`,
        );
      }
    }
  }
}
process.exit(0);
