/**
 * BGE-M3 uctan uca sunum olcumu (karar 0196): GERCEK sunum yolu (`serveSemantic`), gercek lexical
 * arama, gercek HNSW indeksi, gercek sorgu servisi (TEI) + kanarya kapisi. Yalniz YEREL veritabani.
 * Ucretli cagri yok. Etiketler AI destekli on degerlendirmedir (insan etiketi DEGIL); puanlanmamis
 * urunler 0 sayilmaz ("yogun" metrik: yalniz puanli urunler).
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:.../arilla_imp EMBED_BGE_M3_QUERY_URL=http://127.0.0.1:18080 \
 *   node --experimental-transform-types scripts/bge-serving-e2e.ts \
 *       <queries.tsv> <puanlar.csv> <anahtar.csv> <out.json> [hybrid-tune.json]
 *
 * A = yalniz lexical (bugunku uretim davranisi), B = lexical + BGE-M3 sunumu. Ayrica servis kapaliyken
 * (olu port) sonucun A ile BIREBIR ayni oldugu denetlenir (fallback).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import { emptyIntent } from "../src/chat/intent.ts";
import { intentToQueryObject } from "../src/chat/search-adapter.ts";
import { createSeedAliasSource } from "../src/search/fallback/aliases.ts";
import { searchWithFallback } from "../src/search/fallback/pipeline.ts";
import { createPostgresSearchProvider } from "../src/search/fallback/postgres-provider.ts";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import { prepareSearchFilters, serveSemantic } from "../src/search/search-domain.ts";
import { canaryStatus } from "../src/search/semantic/query-canary.ts";
import type { ServingTelemetry } from "../src/search/semantic/serving.ts";

function csv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  const [head = [], ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const dcg = (rs: number[]) => rs.reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0) : 0;
};
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : Number.NaN;
};

async function main() {
  const [queriesPath, scoresPath, keyPath, outPath, tunePath] = process.argv.slice(2);
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  const endpoint = process.env.EMBED_BGE_M3_QUERY_URL ?? "";
  const db = createDatabase(url);
  const lexicon = await loadLexiconCached(db);
  const queries = readFileSync(queriesPath ?? "", "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split("\t") as [string, string, string]);
  const scores = new Map(csv(scoresPath ?? "").map((r) => [r.item_id, Number(r.oneri_puan_0_3)]));
  const labels = new Map<string, number>();
  const pools = new Map<string, number[]>();
  for (const k of csv(keyPath ?? "")) {
    const s = scores.get(k.item_id ?? "");
    if (s === undefined || Number.isNaN(s)) continue;
    labels.set(`${k.query_id}:${k.product_id}`, s);
    pools.set(k.query_id ?? "", [...(pools.get(k.query_id ?? "") ?? []), s]);
  }
  const split = tunePath
    ? (
        JSON.parse(readFileSync(tunePath, "utf8")) as {
          split: { dev: string[]; holdout: string[] };
        }
      ).split
    : null;

  const env = (u: string) => ({
    SEMANTIC_SEARCH_MODE: "on",
    SEMANTIC_EMBEDDING_MODEL: "bge-m3-5617a9f6",
    SEMANTIC_INDEX_VERSION: "1",
    EMBED_BGE_M3_QUERY_URL: u,
  });
  const deps = (u: string) => ({
    env: env(u),
    usedToday: async () => 0,
    log: () => undefined,
  });

  const lexicalFor = async (query: string) => {
    const intent = emptyIntent(query);
    let parsed = intentToQueryObject(intent, lexicon);
    parsed = await prepareSearchFilters(db, parsed);
    const outcome = await searchWithFallback(
      createPostgresSearchProvider(db),
      { parsed, sort: "balanced", page: 1, pageSize: 24 },
      { aliases: createSeedAliasSource() },
    );
    return { parsed, outcome };
  };

  // Kanarya kapisi gecene kadar bekle (gercek TEI'ye karsi; gate arka planda calisir).
  const first = await lexicalFor("kablosuz kulaklik");
  const started = Date.now();
  for (;;) {
    await serveSemantic(
      db,
      first.parsed,
      first.outcome,
      { page: 1, sort: "balanced" },
      deps(endpoint),
    );
    const status = canaryStatus()["bge-m3-5617a9f6"];
    if (status?.state === "passed" || Date.now() - started > 60_000) {
      console.log("kanarya:", JSON.stringify(status));
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const rows = [];
  const wallMs: number[] = [];
  const embedMs: number[] = [];
  const knnMs: number[] = [];
  let fallbackIdentical = 0;
  for (const [id, query, group] of queries) {
    const { parsed, outcome } = await lexicalFor(query);
    const t0 = performance.now();
    const served = await serveSemantic(
      db,
      parsed,
      outcome,
      { page: 1, sort: "balanced" },
      deps(endpoint),
    );
    const wall = performance.now() - t0;
    const tel: ServingTelemetry = served.telemetry;
    if (tel.outcome === "served") {
      wallMs.push(wall);
      if (tel.embedMs !== null) embedMs.push(tel.embedMs);
      if (tel.knnMs !== null) knnMs.push(tel.knnMs);
    }
    // Fallback: olu port -> sonuc A ile birebir ayni dizi
    // Surec onbellegi (model + sorgu) ayni sorguyu olu porta ragmen saglar; bu yuzden benzersiz metin.
    const dead = await serveSemantic(
      db,
      parsed,
      outcome,
      { page: 1, sort: "balanced", semanticText: `${query} fallbackprobe${id}` },
      deps("http://127.0.0.1:1"),
    );
    if (dead.outcome.items === outcome.items) fallbackIdentical += 1;
    const a = outcome.items.slice(0, 10).map((i) => i.productId);
    const b = served.outcome.items.slice(0, 10).map((i) => i.productId);
    const measure = (ids: number[]) => {
      const judged = ids
        .map((p) => labels.get(`${id}:${p}`))
        .filter((x): x is number => x !== undefined);
      const ideal = dcg([...(pools.get(id) ?? [])].sort((x, y) => y - x).slice(0, 10));
      const first2 = judged.findIndex((g) => g >= 2);
      return {
        ndcg: ideal ? dcg(judged) / ideal : null,
        p10: judged.length ? judged.filter((g) => g >= 2).length / judged.length : null,
        mrr: judged.length ? (first2 < 0 ? 0 : 1 / (first2 + 1)) : null,
        judged: judged.length,
        shown: ids.length,
      };
    };
    rows.push({
      id,
      query,
      group,
      lexicalMode: outcome.mode,
      lexicalCount: outcome.items.length,
      telemetry: tel,
      a,
      b,
      added: served.outcome.items.length - outcome.items.length,
      // Sozlesme: metin sonucu HIC dusmez. Goreli sira korunmasi AYRI raporlanir: kosullu birlestirme,
      // olumsuzlanan/aksesuar gorunumlu metin sonucunu BILEREK asagi tasir (silmez).
      textPresent: outcome.items.every((i) =>
        served.outcome.items.some((x) => x.productId === i.productId),
      ),
      textOrderKept: (() => {
        const pos = served.outcome.items.map((i) => i.productId);
        let last = -1;
        for (const i of outcome.items) {
          const at = pos.indexOf(i.productId);
          if (at < last) return false;
          last = at;
        }
        return true;
      })(),
      mA: measure(a),
      mB: measure(b),
    });
  }

  const labeled = rows.filter((r) => r.mA.ndcg !== null);
  const summarize = (subset: typeof rows) => ({
    n: subset.length,
    A: {
      ndcg: mean(subset.map((r) => r.mA.ndcg)),
      p10: mean(subset.map((r) => r.mA.p10)),
      mrr: mean(subset.map((r) => r.mA.mrr)),
    },
    B: {
      ndcg: mean(subset.map((r) => r.mB.ndcg)),
      p10: mean(subset.map((r) => r.mB.p10)),
      mrr: mean(subset.map((r) => r.mB.mrr)),
    },
    judgedShareA:
      subset.reduce((s, r) => s + r.mA.judged, 0) /
      Math.max(
        1,
        subset.reduce((s, r) => s + r.mA.shown, 0),
      ),
    judgedShareB:
      subset.reduce((s, r) => s + r.mB.judged, 0) /
      Math.max(
        1,
        subset.reduce((s, r) => s + r.mB.shown, 0),
      ),
  });
  const outcomes: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.telemetry.outcome}:${r.telemetry.reason}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const summary = {
    queries: rows.length,
    labeled: labeled.length,
    outcomes,
    textDroppedQueries: rows.filter((r) => !r.textPresent).length,
    textOrderChangedQueries: rows.filter((r) => !r.textOrderKept).length,
    changedTop10: rows.filter((r) => r.a.join() !== r.b.join()).length,
    addedTotal: rows.reduce((s, r) => s + r.added, 0),
    fallbackIdentical: `${fallbackIdentical}/${rows.length}`,
    latency_ms: {
      serve_wall_p50: Math.round(pct(wallMs, 0.5)),
      serve_wall_p95: Math.round(pct(wallMs, 0.95)),
      embed_p50: Math.round(pct(embedMs, 0.5)),
      embed_p95: Math.round(pct(embedMs, 0.95)),
      knn_p50: Math.round(pct(knnMs, 0.5)),
      knn_p95: Math.round(pct(knnMs, 0.95)),
      n: wallMs.length,
    },
    all: summarize(labeled),
    dev: split ? summarize(labeled.filter((r) => split.dev.includes(r.id))) : null,
    holdout: split ? summarize(labeled.filter((r) => split.holdout.includes(r.id))) : null,
  };
  writeFileSync(outPath ?? "", JSON.stringify({ summary, rows }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
