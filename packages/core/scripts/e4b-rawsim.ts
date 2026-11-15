/**
 * E4b C+ v3: yazimlarin buldugu adaylari HAM sorgu vektoruyle yeniden olcer (yalniz yerel DB).
 * Boylece aday bulma (yazim) ile siralama (ham sorgu anlami) birbirinden ayrilir.
 *
 *   DATABASE_URL=...127.0.0.1... node --experimental-transform-types scripts/e4b-rawsim.ts \
 *       <cache.json> <vectors.json> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import type { SemanticIndex } from "../src/search/semantic/active-index.ts";
import { similaritiesFor } from "../src/search/semantic/semantic-candidates.ts";
import type { CachedQuery } from "./bge-tune.ts";

const INDEX: SemanticIndex = {
  modelVersion: "bge-m3-5617a9f6",
  table: "product_text_embedding_d1024",
  dimensions: 1024,
  queryTask: "query",
};

async function main() {
  const [cachePath, vectorsPath, outPath] = process.argv.slice(2);
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  const db = createDatabase(url);
  const queries = (JSON.parse(readFileSync(cachePath ?? "", "utf8")) as { queries: CachedQuery[] })
    .queries;
  const vectors = (
    JSON.parse(readFileSync(vectorsPath ?? "", "utf8")) as {
      vectors: Record<string, number[]>;
    }
  ).vectors;
  const ids = new Map<string, Set<number>>();
  for (const q of queries) {
    const qid = q.id.split(":")[1] ?? "";
    const set = ids.get(qid) ?? new Set<number>();
    for (const l of q.lexical) set.add(l.productId);
    for (const c of q.candidates) set.add(c.productId);
    ids.set(qid, set);
  }
  const out: Record<string, Record<number, number>> = {};
  for (const [qid, set] of ids) {
    const vector = vectors[`O:${qid}`];
    if (!vector) continue;
    const sims = await similaritiesFor(db, {
      vector,
      modelVersion: INDEX.modelVersion,
      productIds: [...set],
      index: INDEX,
    });
    out[qid] = Object.fromEntries([...sims].map(([k, v]) => [k, Math.round(v * 10000) / 10000]));
  }
  writeFileSync(outPath ?? "", JSON.stringify(out));
  console.log(`ham benzerlik: ${Object.keys(out).length} sorgu`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
