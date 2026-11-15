/**
 * E4 hybrid tanisi — YALNIZ yerel degerlendirme veritabani. Secili sorgularda bugunku
 * `fuseForQuery` icini (kaynak, RRF puani, benzerlik, kapi) AI on degerlendirme puaniyla gosterir.
 *
 *   node --experimental-transform-types scripts/bge-diagnose.ts <queries.tsv> <vectors.json> \
 *        <puanlar.csv> <anahtar.csv> Q21,Q06,... > tani.md
 */
import { readFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { emptyIntent } from "../src/chat/intent.ts";
import { intentToQueryObject, searchByIntent } from "../src/chat/search-adapter.ts";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import type { SemanticIndex } from "../src/search/semantic/active-index.ts";
import { DEFAULT_SEMANTIC_GATE } from "../src/search/semantic/config.ts";
import { gateSemantic } from "../src/search/semantic/fusion.ts";
import {
  findSemanticCandidates,
  similaritiesFor,
} from "../src/search/semantic/semantic-candidates.ts";
import { fuseForQuery } from "../src/search/semantic/shadow.ts";
import { loadLabels } from "./e4-labels.ts";

const MODEL = "bge-m3-5617a9f6";
const INDEX: SemanticIndex = {
  modelVersion: MODEL,
  table: "product_text_embedding_d1024",
  dimensions: 1024,
  queryTask: "query",
};

async function main() {
  const [queriesPath, vectorsPath, scoresPath, keyPath, idList] = process.argv.slice(2);
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  process.env.SEMANTIC_SEARCH_MODE = "off";
  const db = createDatabase(url);
  const labels = loadLabels(scoresPath ?? "", keyPath ?? "");
  const vectors = JSON.parse(readFileSync(vectorsPath ?? "", "utf8")).vectors as Record<
    string,
    number[]
  >;
  const queries = new Map(
    readFileSync(queriesPath ?? "", "utf8")
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .map((c) => [c[0] ?? "", c[1] ?? ""]),
  );
  const lexicon = await loadLexiconCached(db);
  const out: string[] = [
    "# E4 hybrid tanisi (AI on degerlendirme puanlari, insan dogrulamasi YOK)",
    "",
  ];
  for (const id of (idList ?? "").split(",")) {
    const query = queries.get(id) ?? "";
    const vector = vectors[id] ?? [];
    const intent = emptyIntent(query);
    const parsed = intentToQueryObject(intent, lexicon);
    const text = await searchByIntent(db, intent, { pageSize: 10, lexicon });
    const lexical = text.outcome.items
      .slice(0, 10)
      .map((i) => ({ productId: i.productId, title: i.title }));
    const candidates = await findSemanticCandidates(db, {
      vector,
      modelVersion: MODEL,
      index: INDEX,
      text: parsed.text,
      filters: parsed.filters,
      statementTimeoutMs: 60_000,
    });
    const textSimilarity = await similaritiesFor(db, {
      vector,
      modelVersion: MODEL,
      productIds: lexical.map((i) => i.productId),
      index: INDEX,
    });
    const { fused } = fuseForQuery(lexical, candidates, parsed.text, textSimilarity);
    const passed = gateSemantic(
      candidates,
      new Set(lexical.map((i) => i.productId)),
      DEFAULT_SEMANTIC_GATE,
    );
    const ids = [
      ...new Set([
        ...fused.slice(0, 15).map((f) => f.item.productId),
        ...lexical.map((l) => l.productId),
      ]),
    ];
    const cats = await db.execute<{ id: string; path: string | null }>(sql`
      SELECT p.id::text AS id, c.path FROM product p LEFT JOIN category c ON c.id = p.category_id
       WHERE p.id = ANY(${sql.param(ids)}::bigint[])`);
    const cat = new Map(cats.rows.map((r) => [Number(r.id), r.path ?? "-"]));
    const lab = (pid: number) => labels.get(`${id}:${pid}`) ?? "?";
    const lexSims = lexical.map((l) => textSimilarity.get(l.productId) ?? 0);
    out.push(
      `## ${id} — ${query}`,
      "",
      `aday ${candidates.length}, kapidan gecen ${passed.length} (yalniz-semantic ${passed.filter((p) => !lexical.some((l) => l.productId === p.productId)).length}); ` +
        `dense en iyi ${candidates[0]?.similarity.toFixed(3) ?? "-"}; lexical benzerlik min/ort/maks ` +
        `${Math.min(...lexSims).toFixed(3)}/${(lexSims.reduce((a, b) => a + b, 0) / Math.max(1, lexSims.length)).toFixed(3)}/${Math.max(...lexSims).toFixed(3)}`,
      "",
      "| sira | kaynak | RRF puani | kosinus | AI puan | kategori | baslik |",
      "|---|---|---|---|---|---|---|",
    );
    fused.slice(0, 12).forEach((f, i) => {
      out.push(
        `| ${i + 1} | ${f.source} | ${f.score.toFixed(5)} | ${f.similarity?.toFixed(3) ?? "-"} | ${lab(f.item.productId)} | ${cat.get(f.item.productId) ?? "-"} | ${f.item.title.slice(0, 80).replaceAll("|", "/")} |`,
      );
    });
    out.push("", "Lexical sirasi (AI puan / kosinus):", "");
    lexical.forEach((l, i) =>
      out.push(
        `${i + 1}. [${lab(l.productId)} / ${(textSimilarity.get(l.productId) ?? 0).toFixed(3)}] ${l.title.slice(0, 80)}`,
      ),
    );
    out.push("");
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
