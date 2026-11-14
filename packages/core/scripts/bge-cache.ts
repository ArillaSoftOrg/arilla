/**
 * E4: hybrid ayari icin aday onbellegi — YALNIZ yerel degerlendirme veritabani.
 * Her sorgu icin lexical sonuclar (eslesme duzeyi/asamasi dahil), korumali anlamsal adaylar,
 * lexical urunlerin kosinusu ve kategori yollari bir kez cikarilir; ayar cevrimdisi yapilir.
 *
 *   node --experimental-transform-types scripts/bge-cache.ts <queries.tsv> <vectors.json> <out.json> \
 *        [--ef N]     # verilirse aday KNN'i HNSW (ef N) ile; yoksa indeks yokken kesin
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { emptyIntent } from "../src/chat/intent.ts";
import { intentToQueryObject, searchByIntent } from "../src/chat/search-adapter.ts";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import type { SemanticIndex } from "../src/search/semantic/active-index.ts";
import {
  findSemanticCandidates,
  similaritiesFor,
} from "../src/search/semantic/semantic-candidates.ts";

const MODEL = "bge-m3-5617a9f6";
const INDEX: SemanticIndex = {
  modelVersion: MODEL,
  table: "product_text_embedding_d1024",
  dimensions: 1024,
  queryTask: "query",
};

async function main() {
  const [queriesPath, vectorsPath, outPath] = process.argv.slice(2);
  const efArg = process.argv.indexOf("--ef");
  const ef = efArg > 0 ? Number(process.argv[efArg + 1]) : null;
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  process.env.SEMANTIC_SEARCH_MODE = "off";
  const db = createDatabase(url);
  const vectors = JSON.parse(readFileSync(vectorsPath ?? "", "utf8")).vectors as Record<
    string,
    number[]
  >;
  const rows = readFileSync(queriesPath ?? "", "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const lexicon = await loadLexiconCached(db);
  const out: unknown[] = [];
  const lat: number[] = [];
  for (const [id = "", query = "", group = ""] of rows) {
    const vector = vectors[id] ?? [];
    const intent = emptyIntent(query);
    const parsed = intentToQueryObject(intent, lexicon);
    const text = await searchByIntent(db, intent, { pageSize: 10, lexicon, timeoutMs: 30_000 });
    const lexical = text.outcome.items.slice(0, 10).map((i) => ({
      productId: i.productId,
      title: i.title,
      tier: i.match?.tier ?? null,
      stage: i.match?.stage ?? null,
      missing: i.match?.missing ?? [],
    }));
    const started = process.hrtime.bigint();
    const candidates = await findSemanticCandidates(db, {
      vector,
      modelVersion: MODEL,
      index: INDEX,
      text: parsed.text,
      filters: parsed.filters,
      statementTimeoutMs: 60_000,
      ...(ef ? { knnLimit: ef, efSearch: ef } : {}),
    });
    lat.push(Number(process.hrtime.bigint() - started) / 1e6);
    const textSimilarity = await similaritiesFor(db, {
      vector,
      modelVersion: MODEL,
      productIds: lexical.map((i) => i.productId),
      index: INDEX,
    });
    const ids = [
      ...new Set([...lexical.map((l) => l.productId), ...candidates.map((c) => c.productId)]),
    ];
    const cats = await db.execute<{ id: string; path: string | null }>(sql`
      SELECT p.id::text AS id, c.path FROM product p LEFT JOIN category c ON c.id = p.category_id
       WHERE p.id = ANY(${sql.param(ids)}::bigint[])`);
    const category = Object.fromEntries(cats.rows.map((r) => [r.id, r.path]));
    out.push({
      id,
      query,
      group,
      parsedText: parsed.text,
      filters: parsed.filters,
      lexical: lexical.map((l) => ({
        ...l,
        similarity: textSimilarity.get(l.productId) ?? null,
        category: category[String(l.productId)] ?? null,
      })),
      candidates: candidates.map((c) => ({
        ...c,
        category: category[String(c.productId)] ?? null,
      })),
    });
    process.stderr.write(`${id} lex=${lexical.length} cand=${candidates.length}\n`);
  }
  lat.sort((a, b) => a - b);
  const p = (q: number) => Math.round((lat[Math.floor(q * (lat.length - 1))] ?? 0) * 10) / 10;
  writeFileSync(
    outPath ?? "",
    JSON.stringify({ ef, candidate_latency_ms: { p50: p(0.5), p95: p(0.95) }, queries: out }),
  );
  console.log(JSON.stringify({ ef, candidate_latency_ms: { p50: p(0.5), p95: p(0.95) } }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
