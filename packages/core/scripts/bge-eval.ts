/**
 * E4 BGE-M3 alma (retrieval) degerlendirmesi — YALNIZ yerel, yalitilmis veritabani (127.0.0.1).
 *
 *   node scripts/bge-eval.ts run  <queries.tsv> <query_vectors.json> <cikti-dizini> [--hnsw]
 *   node scripts/bge-eval.ts blind <cikti-dizini>        # kor etiketleme dosyalari
 *
 * Ayni 158 bin urun uzerinde, her sorgu icin:
 *   A. lexical  : bugunku /sohbet katalog yolu (`searchByIntent`), degismeden
 *   B. dense    : saf BGE-M3 kosinus, KESIN (seq scan), filtre/koruma yok
 *   C. hybrid   : mevcut mimari = A + korumali anlamsal adaylar (`findSemanticCandidates`) +
 *                 `fuseForQuery` (golge olcum ve sunumla ayni birlestirme)
 *   --hnsw      : B'yi HNSW ile (ef 40/100/200) tekrarlar; ANN Recall@10 = kesin ilk 10'a gore.
 *                 Bu isabet ALAKA KALITESI DEGILDIR.
 * Sorgu vektorleri uretim TEI'sinde (ayni model/revizyon/havuzlama) onceden uretilmistir.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, type Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { emptyIntent } from "../src/chat/intent.ts";
import { intentToQueryObject, searchByIntent } from "../src/chat/search-adapter.ts";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import type { SemanticIndex } from "../src/search/semantic/active-index.ts";
import {
  findSemanticCandidates,
  similaritiesFor,
} from "../src/search/semantic/semantic-candidates.ts";
import { fuseForQuery } from "../src/search/semantic/shadow.ts";

const TOP = 10;
const MODEL = "bge-m3-5617a9f6";
const INDEX: SemanticIndex = {
  modelVersion: MODEL,
  table: "product_text_embedding_d1024",
  dimensions: 1024,
  queryTask: "query",
};

interface QueryRow {
  id: string;
  query: string;
  group: string;
  presence_regex: string;
  note: string;
}

function readQueries(path: string): QueryRow[] {
  const [head, ...lines] = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = (head ?? "").split("\t");
  return lines.map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""])) as unknown as QueryRow;
  });
}

const literal = (v: readonly number[]) => `[${v.join(",")}]`;
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;

async function denseTop(
  db: Database,
  vector: readonly number[],
  k: number,
  mode: { exact: true } | { exact: false; ef: number },
): Promise<{ ids: number[]; sims: number[]; ms: number }> {
  return db.transaction(async (tx) => {
    if (mode.exact) {
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    } else {
      await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${mode.ef}`));
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    }
    const started = process.hrtime.bigint();
    const rows = await tx.execute<{ id: string; sim: number }>(sql`
      SELECT e.product_id::text AS id,
             (1 - (e.embedding <=> ${literal(vector)}::halfvec(1024)))::float8 AS sim
        FROM product_text_embedding_d1024 e
       WHERE e.model_version = 'bge-m3-5617a9f6'
       ORDER BY e.embedding <=> ${literal(vector)}::halfvec(1024)
       LIMIT ${k}`);
    return {
      ids: rows.rows.map((r) => Number(r.id)),
      sims: rows.rows.map((r) => Number(r.sim)),
      ms: ms(started),
    };
  });
}

function pct(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]! * 10) / 10;
}

async function run(queriesPath: string, vectorsPath: string, out: string, hnsw: boolean) {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  process.env.SEMANTIC_SEARCH_MODE = "off"; // canli sunum yolu kapali: A saf metin aramasi
  const db = createDatabase(url);
  const queries = readQueries(queriesPath);
  const qv = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
    vectors: Record<string, number[]>;
    model: string;
  };
  if (qv.model !== MODEL) throw new Error("sorgu vektorleri baska modelden");
  const lexicon = await loadLexiconCached(db);
  const results: unknown[] = [];
  const lat = { lexical: [] as number[], exact: [] as number[], hybridSem: [] as number[] };
  const ann: Record<number, { recall: number[]; tie: number[]; ms: number[] }> = {};
  for (const q of queries) {
    const vector = qv.vectors[q.id];
    if (!vector) throw new Error(`vektor yok: ${q.id}`);
    const intent = emptyIntent(q.query);
    const parsed = intentToQueryObject(intent, lexicon);

    let t = process.hrtime.bigint();
    const text = await searchByIntent(db, intent, { pageSize: TOP, lexicon });
    lat.lexical.push(ms(t));
    const lexical = text.outcome.items
      .slice(0, TOP)
      .map((i) => ({ productId: i.productId, title: i.title }));

    await denseTop(db, vector, TOP, { exact: true }); // isinma
    const exact = await denseTop(db, vector, 50, { exact: true });
    lat.exact.push(exact.ms);

    t = process.hrtime.bigint();
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
    lat.hybridSem.push(ms(t));
    const { fused } = fuseForQuery(lexical, candidates, parsed.text, textSimilarity);
    const hybrid = fused.slice(0, TOP).map((e) => e.item.productId);

    const annRow: Record<string, unknown> = {};
    if (hnsw) {
      const truth = new Set(exact.ids.slice(0, TOP));
      const tenth = exact.sims[TOP - 1] ?? 1;
      for (const ef of [40, 100, 200, 400]) {
        await denseTop(db, vector, TOP, { exact: false, ef });
        const a = await denseTop(db, vector, TOP, { exact: false, ef });
        const hit = a.ids.filter((id) => truth.has(id)).length / TOP;
        // Esitlik duyarli: ayni vektorlu kopyalar arasinda hangisinin dondugu kayip degildir.
        const tieHit = a.sims.filter((s) => s >= tenth - 1e-4).length / TOP;
        ann[ef] ??= { recall: [], tie: [], ms: [] };
        ann[ef].recall.push(hit);
        ann[ef].tie.push(tieHit);
        ann[ef].ms.push(a.ms);
        annRow[`ef${ef}`] = {
          recall10: hit,
          recall10_ties: tieHit,
          ms: Math.round(a.ms * 10) / 10,
        };
      }
    }
    results.push({
      id: q.id,
      query: q.query,
      group: q.group,
      note: q.note,
      presence_keyword_matches: null,
      parsed: { text: parsed.text, filters: parsed.filters, unparsed: parsed.unparsed },
      lexical: lexical.map((i) => i.productId),
      dense: exact.ids.slice(0, TOP),
      dense_sims: exact.sims.slice(0, TOP).map((s) => Math.round(s * 10000) / 10000),
      hybrid,
      semantic_candidates: candidates.length,
      ann: annRow,
    });
    process.stderr.write(
      `${q.id} lex=${lexical.length} dense=${exact.ids.length} hyb=${hybrid.length}\n`,
    );
  }
  const summary = {
    queries: queries.length,
    latency_ms_local: {
      lexical: { p50: pct(lat.lexical, 0.5), p95: pct(lat.lexical, 0.95) },
      dense_exact_158k: { p50: pct(lat.exact, 0.5), p95: pct(lat.exact, 0.95) },
      hybrid_semantic_part: { p50: pct(lat.hybridSem, 0.5), p95: pct(lat.hybridSem, 0.95) },
    },
    ann: Object.fromEntries(
      Object.entries(ann).map(([ef, v]) => [
        `ef${ef}`,
        {
          recall10_mean:
            Math.round((v.recall.reduce((a, b) => a + b, 0) / v.recall.length) * 1000) / 1000,
          below_0_8: v.recall.filter((r) => r < 0.8).length,
          recall10_ties_mean:
            Math.round((v.tie.reduce((a, b) => a + b, 0) / v.tie.length) * 1000) / 1000,
          ties_below_0_8: v.tie.filter((r) => r < 0.8).length,
          p50_ms: pct(v.ms, 0.5),
          p95_ms: pct(v.ms, 0.95),
        },
      ]),
    ),
    empty_lexical: (results as { lexical: number[] }[]).filter((r) => r.lexical.length === 0)
      .length,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, hnsw ? "results-hnsw.json" : "results.json"),
    JSON.stringify({ summary, results }, null, 1),
  );
  console.log(JSON.stringify(summary, null, 1));
}

/** Deterministik karistirma (etiketleyici sira/yontem ipucu almasin). */
function shuffle<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

async function blind(out: string) {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  const db = createDatabase(url);
  const { results } = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as {
    results: { id: string; query: string; lexical: number[]; dense: number[]; hybrid: number[] }[];
  };
  const ids = [...new Set(results.flatMap((r) => [...r.lexical, ...r.dense, ...r.hybrid]))];
  const meta = await db.execute<{
    id: string;
    title: string;
    brand: string | null;
    category: string | null;
    price: number | null;
    currency: string | null;
    merchant: string | null;
  }>(sql`
    SELECT p.id::text AS id, p.title, b.name AS brand, c.path AS category,
           (SELECT o.current_price FROM offer o WHERE o.product_id = p.id ORDER BY o.current_price LIMIT 1) AS price,
           (SELECT o.currency FROM offer o WHERE o.product_id = p.id ORDER BY o.current_price LIMIT 1) AS currency,
           m.name AS merchant
      FROM product p LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      LEFT JOIN merchant m ON m.id = p.source_merchant_id
     WHERE p.id = ANY(${sql.param(ids)}::bigint[])`);
  const byId = new Map(meta.rows.map((r) => [Number(r.id), r]));
  const labelRows: string[] = [
    "item_id,query_id,query,title,brand,category,price,currency,source,relevance_0_3,note,labeler",
  ];
  const keyRows: string[] = ["item_id,query_id,product_id,lexical_rank,dense_rank,hybrid_rank"];
  const md: string[] = [
    "# E4 kor etiketleme listesi",
    "",
    "Her sorgu icin urunler KARISIK sirada; hangi yontemden geldigi gizlidir (anahtar ayri dosyada).",
    "Alaka: 3 ihtiyaci dogru karsilar · 2 ilgili ama onemli fark · 1 zayif · 0 ilgisiz/yanlis.",
    "Fiyatlar kaynak para biriminde (USD, kurus/cent). TRY fiyat bu alt kumede YOK.",
    "",
  ];
  let seq = 0;
  for (const r of results) {
    const pool = [...new Set([...r.lexical, ...r.dense, ...r.hybrid])];
    const order = shuffle(pool, Number.parseInt(r.id.slice(1), 10) * 7919);
    md.push(
      `## ${r.id} — ${r.query}`,
      "",
      "| oge | baslik | kategori | fiyat | alaka |",
      "|---|---|---|---|---|",
    );
    for (const pid of order) {
      seq += 1;
      const item = `I${String(seq).padStart(4, "0")}`;
      const m = byId.get(pid);
      const rank = (list: number[]) => {
        const i = list.indexOf(pid);
        return i < 0 ? "" : String(i + 1);
      };
      labelRows.push(
        [
          item,
          r.id,
          r.query,
          m?.title,
          m?.brand,
          m?.category,
          m?.price,
          m?.currency,
          m?.merchant,
          "",
          "",
          "",
        ]
          .map(csvCell)
          .join(","),
      );
      keyRows.push([item, r.id, pid, rank(r.lexical), rank(r.dense), rank(r.hybrid)].join(","));
      const price = m?.price == null ? "-" : `${(Number(m.price) / 100).toFixed(2)} ${m.currency}`;
      md.push(
        `| ${item} | ${(m?.title ?? "").replaceAll("|", "/")} | ${m?.category ?? "(yok)"} | ${price} | |`,
      );
    }
    md.push("");
  }
  writeFileSync(join(out, "etiketleme-kor.csv"), `﻿${labelRows.join("\n")}\n`);
  writeFileSync(join(out, "etiketleme-anahtar.csv"), `${keyRows.join("\n")}\n`);
  writeFileSync(join(out, "etiketleme-kor.md"), `${md.join("\n")}\n`);
  console.log(`oge ${seq}, sorgu ${results.length}`);
}

const [mode, a, b, c] = process.argv.slice(2);
const main =
  mode === "run"
    ? run(a!, b!, c!, process.argv.includes("--hnsw"))
    : mode === "blind"
      ? blind(a!)
      : Promise.reject(new Error("mod: run | blind"));
main
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
