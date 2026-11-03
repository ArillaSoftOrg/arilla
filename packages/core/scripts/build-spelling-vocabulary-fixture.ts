/**
 * Yazim duzeltici icin DB'siz sozcuk dagarcigi fixture'i (karar 0172).
 *
 * Uretim yukleyicisi (`search/spelling/vocabulary-repository.ts`) ayni uc kaynagi canli DB'den
 * okur: `category.name`, `lexicon` ve `brand.name`. Bu betik ilk ikisini depodaki migration
 * verisinden cikarir; testler ve degerlendirme boylece DB'siz ve deterministik calisir:
 *
 * - `category`: Trendyol agaci (0097 ham adlar; 0102 bunlari aktif agaca ekler).
 * - `lexicon`: 0020 + 0087 migration satirlari ve `classification-lexicon.fixture.json`
 *   (Python `classify lexicon --apply` ciktisinin aynasi).
 *
 * `brand` tablosu depoda yok (feed'lerden dolar); degerlendirme icin ayri, acikca "uretim
 * yerine gecen" isaretli liste kullanilir: `eval/datasets/query-normalization.brands.json`.
 *
 * Calistirma: node packages/core/scripts/build-spelling-vocabulary-fixture.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const migrations = join(repo, "packages", "db", "migrations");
const out = join(here, "..", "src", "search", "spelling", "vocabulary.fixture.json");

function unquote(sqlString: string): string {
  return sqlString.replace(/''/g, "'");
}

function trendyolCategoryNames(): string[] {
  const text = readFileSync(join(migrations, "0097_trendyol_category_reference_seed.sql"), "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*\(\d+, (?:\d+|NULL), '((?:[^']|'')*)', \d+,/gmu)) {
    names.add(unquote(match[1] as string).trim());
  }
  return [...names].sort((a, b) => a.localeCompare(b, "tr"));
}

interface LexiconRow {
  kind: string;
  surface: string;
  normalized: string;
}

function migrationLexicon(file: string): LexiconRow[] {
  const text = readFileSync(join(migrations, file), "utf8");
  const rows: LexiconRow[] = [];
  for (const match of text.matchAll(
    /\(\s*'([a-z]+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\s*\)/gu,
  )) {
    rows.push({
      kind: match[1] as string,
      surface: unquote(match[2] as string),
      normalized: unquote(match[3] as string),
    });
  }
  return rows;
}

function classificationLexicon(): LexiconRow[] {
  const file = join(here, "..", "src", "search", "classification-lexicon.fixture.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : ((parsed as { entries?: unknown[] }).entries ?? []);
  return (entries as LexiconRow[]).map(({ kind, surface, normalized }) => ({
    kind,
    surface,
    normalized,
  }));
}

const lexicon = [
  ...migrationLexicon("0020_lexicon_synonym_kind.sql"),
  ...migrationLexicon("0087_lexicon_tr_en_product_synonyms.sql"),
  ...classificationLexicon(),
];
const seen = new Set<string>();
const uniqueLexicon = lexicon.filter((row) => {
  const key = `${row.kind}\u0000${row.surface}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const fixture = {
  _aciklama:
    "Uretilmis dosya (scripts/build-spelling-vocabulary-fixture.ts); elle duzenlenmez. Kaynak: 0097 Trendyol kategori adlari, 0020/0087 lexicon satirlari, classification-lexicon.fixture.json.",
  categories: trendyolCategoryNames(),
  lexicon: uniqueLexicon,
};
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`categories=${fixture.categories.length} lexicon=${fixture.lexicon.length} -> ${out}`);
