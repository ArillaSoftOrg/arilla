/**
 * BGE-M3 HNSW olcumu (karar 0196): YALNIZ yerel degerlendirme veritabani; ucretli cagri/model YOK.
 * Onceden uretilmis sorgu vektorleri (id -> 1024 sayi) kullanilir.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:.../arilla_imp node --experimental-transform-types \
 *     scripts/bge-hnsw-bench.ts <vectors.json> <out.json> [--model bge-m3-5617a9f6] [--prefix O:]
 *
 * Olculer (her sorgu icin, tam tarama ground truth):
 * - recall@10 ve recall@150 (sunumun aday penceresi) HNSW ef_search in {40, 100, 150, 400} icin.
 * - KATEGORI SUZGECLI recall@10: sorgunun en yakin urununun kategorisi icinde (alt kategoriler dahil)
 *   HNSW + sonradan suzme, tam tarama gercegine karsi. E3-d.1'de gorulen kotu recall (0,2-0,7) BURADA
 *   da olculur ve GIZLENMEZ; sunum bu durumda HNSW'ye guvenmez (strateji secici, karar 0189/0190).
 * - Sunumun gercek aday sorgusu `findSemanticCandidates` (ef 150, k 150) gecikmesi p50/p95.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { QUERYABLE_INDEXES, type SemanticIndex } from "../src/search/semantic/active-index.ts";
import { findSemanticCandidates } from "../src/search/semantic/semantic-candidates.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main() {
  const [vectorsPath, outPath] = process.argv.slice(2);
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  const model = arg("--model", "bge-m3-5617a9f6");
  const prefix = arg("--prefix", "O:");
  const index = QUERYABLE_INDEXES[model] as SemanticIndex;
  const db = createDatabase(url);
  const vectors = (
    JSON.parse(readFileSync(vectorsPath ?? "", "utf8")) as {
      vectors: Record<string, number[]>;
    }
  ).vectors;
  const queries = Object.entries(vectors).filter(([id]) => id.startsWith(prefix));
  const table = sql.raw(index.table);
  const lit = (v: number[]) => `[${v.join(",")}]`;

  type Row = { product_id: string; d: number };
  interface Hit {
    id: number;
    d: number;
  }
  const topK = async (
    vector: number[],
    k: number,
    mode: { ef?: number; exact?: boolean; categoryIds?: number[] },
  ): Promise<Hit[]> =>
    db.transaction(async (tx) => {
      if (mode.exact) {
        await tx.execute(sql`SET LOCAL enable_indexscan = off`);
        await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      } else {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${Math.trunc(mode.ef ?? 40)}`));
      }
      const filter =
        mode.categoryIds === undefined
          ? sql``
          : sql`AND e.product_id IN (SELECT id FROM product WHERE category_id = ANY(${sql.param(mode.categoryIds)}::bigint[]))`;
      const rows = await tx.execute<Row>(sql`
        SELECT e.product_id::text AS product_id,
               (e.embedding <=> ${lit(vector)}::halfvec(${sql.raw(String(index.dimensions))}))::float8 AS d
          FROM ${table} e
         WHERE e.model_version = ${sql.raw(`'${model}'`)} ${filter}
         ORDER BY e.embedding <=> ${lit(vector)}::halfvec(${sql.raw(String(index.dimensions))})
         LIMIT ${k}`);
      return rows.rows.map((r) => ({ id: Number(r.product_id), d: Number(r.d) }));
    });

  /**
   * Mesafe tabanli recall: tam taramanin k. mesafesi esiktir; ANN sonucu esigi (halfvec yuvarlama payi
   * dahil) asmiyorsa dogru sayilir. Kimlik ortusmesi, ayni vektorlu (yinelenen baslikli) urunlerde
   * haksiz dusuk cikar; bu olcum hem yinelenenleri hem gercek kacirmalari dogru ayirir.
   */
  const EPS = 1e-4;
  const recall = (truth: Hit[], got: Hit[]) => {
    if (truth.length === 0) return null;
    const limit = (truth[truth.length - 1]?.d ?? 0) + EPS;
    return got.filter((h) => h.d <= limit).length / truth.length;
  };
  /** Kimlik ortusmesi (yinelenenleri ayirmaz); karsilastirma icin. */
  const idRecall = (truth: Hit[], got: Hit[]) =>
    truth.length === 0
      ? null
      : truth.filter((t) => got.some((g) => g.id === t.id)).length / truth.length;

  const efs = [40, 100, 150, 400];
  const result: Record<string, unknown> = { model, queries: queries.length, efs };
  const r10: Record<number, number[]> = {};
  const r10id: Record<number, number[]> = {};
  const r150: Record<number, number[]> = {};
  const rCat: Record<number, number[]> = {};
  const annMs: Record<number, number[]> = {};
  for (const ef of efs) {
    r10[ef] = [];
    r10id[ef] = [];
    r150[ef] = [];
    rCat[ef] = [];
    annMs[ef] = [];
  }
  let catQueries = 0;

  for (const [, vector] of queries) {
    const truth10 = await topK(vector, 10, { exact: true });
    const truth150 = await topK(vector, 150, { exact: true });
    // Kategori: en yakin urunun kategorisi (+ alt kategorileri).
    const cat = await db.execute<{ category_id: string | null }>(
      sql`SELECT category_id::text AS category_id FROM product WHERE id = ${truth10[0]?.id ?? 0}`,
    );
    const categoryId = cat.rows[0]?.category_id ? Number(cat.rows[0].category_id) : null;
    let categoryIds: number[] | undefined;
    if (categoryId !== null) {
      const subs = await db.execute<{ id: string }>(sql`
        WITH RECURSIVE t AS (SELECT id FROM category WHERE id = ${categoryId}
          UNION ALL SELECT c.id FROM category c JOIN t ON c.parent_id = t.id)
        SELECT id::text AS id FROM t`);
      categoryIds = subs.rows.map((r) => Number(r.id));
    }
    const truthCat = categoryIds ? await topK(vector, 10, { exact: true, categoryIds }) : [];
    if (truthCat.length > 0) catQueries += 1;
    for (const ef of efs) {
      const started = performance.now();
      const ann10 = await topK(vector, 10, { ef });
      annMs[ef]?.push(performance.now() - started);
      const ann150 = await topK(vector, 150, { ef });
      r10[ef]?.push(recall(truth10, ann10) ?? 1);
      r10id[ef]?.push(idRecall(truth10, ann10) ?? 1);
      r150[ef]?.push(recall(truth150, ann150) ?? 1);
      if (truthCat.length > 0 && categoryIds) {
        // HNSW + sonradan suzme (ef pencere): adaylarin ilk `ef` tanesi suzulur.
        const annCat = await topK(vector, 10, { ef, categoryIds });
        rCat[ef]?.push(recall(truthCat, annCat) ?? 1);
      }
    }
  }
  result.recall = Object.fromEntries(
    efs.map((ef) => [
      ef,
      {
        recall10_mean: Number(mean(r10[ef] ?? []).toFixed(4)),
        recall10_by_id_mean: Number(mean(r10id[ef] ?? []).toFixed(4)),
        recall10_min: Number(Math.min(...(r10[ef] ?? [1])).toFixed(2)),
        recall150_mean: Number(mean(r150[ef] ?? []).toFixed(4)),
        category_filtered_recall10_mean: Number(mean(rCat[ef] ?? []).toFixed(4)),
        category_filtered_recall10_below_0_5: (rCat[ef] ?? []).filter((x) => x < 0.5).length,
        ann_top10_ms_p50: Math.round(pct(annMs[ef] ?? [], 0.5) * 10) / 10,
        ann_top10_ms_p95: Math.round(pct(annMs[ef] ?? [], 0.95) * 10) / 10,
      },
    ]),
  );
  result.category_queries = catQueries;

  // Sunumun gercek aday sorgusu (ef 150, k 150), gecikme.
  const lat: number[] = [];
  for (const [, vector] of queries) {
    const started = performance.now();
    await findSemanticCandidates(db, {
      vector,
      modelVersion: model,
      index,
      text: "x",
      filters: {},
      knnLimit: 150,
      efSearch: 150,
    });
    lat.push(performance.now() - started);
  }
  result.serving_candidate_query_ms = {
    p50: Math.round(pct(lat, 0.5) * 10) / 10,
    p95: Math.round(pct(lat, 0.95) * 10) / 10,
    n: lat.length,
  };
  writeFileSync(outPath ?? "", JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
