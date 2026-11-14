/**
 * E4 kosullu hybrid: gelistirme/dogrulama ayrimi, gelistirmede izgara ayari, dogrulamada tek olcum.
 * Cevrimdisi (aday onbellegi + AI on degerlendirme puanlari); yalniz sozluk icin yerel DB okunur.
 *
 *   node --experimental-transform-types scripts/bge-tune.ts <cache-exact.json> <puanlar.csv> \
 *        <anahtar.csv> <cikti-dizini> [--hnsw cache-ef150.json,cache-ef400.json]
 *
 * PUANLAR AI DESTEKLI ON DEGERLENDIRMEDIR (insan dogrulamasi yok). Puanlanmamis (havuz disi) urun
 * nDCG/P@10/MRR'de 0 sayilir (kotumser) ve ayrica raporlanir.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@arilla/db";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import { looksLikeAccessory, queryWantsAccessory } from "../src/search/semantic/accessory-guard.ts";
import {
  BGE_M3_HYBRID_POLICY,
  buildCandidateCheck,
  conditionalHybrid,
  type HybridPolicy,
  specTokens,
} from "../src/search/semantic/hybrid-policy.ts";
import { fuseForQuery } from "../src/search/semantic/shadow.ts";
import { foldForMatch } from "../src/search/text-match.ts";
import { loadLabels } from "./e4-labels.ts";

interface CachedItem {
  productId: number;
  title: string;
  tier: "exact" | "close" | "related" | null;
  similarity: number | null;
  category: string | null;
}
interface CachedCandidate {
  productId: number;
  title: string;
  similarity: number;
  category: string | null;
}
interface CachedQuery {
  id: string;
  query: string;
  group: string;
  parsedText: string;
  lexical: CachedItem[];
  candidates: CachedCandidate[];
}

const read = (p: string) =>
  JSON.parse(readFileSync(p, "utf8")) as { ef: number | null; queries: CachedQuery[] };

/** Tabakali, deterministik ayrim: grup koku x lexical-bos; tabaka icinde sha1 sirasi; ~%40 dogrulama. */
export function split(queries: readonly CachedQuery[]): { dev: Set<string>; holdout: Set<string> } {
  const strata = new Map<string, CachedQuery[]>();
  for (const q of queries) {
    const key = `${q.group.split("/")[0]}|${q.lexical.length === 0 ? "bos" : "dolu"}`;
    strata.set(key, [...(strata.get(key) ?? []), q]);
  }
  const dev = new Set<string>();
  const holdout = new Set<string>();
  for (const members of strata.values()) {
    const ordered = [...members].sort((a, b) =>
      createHash("sha1")
        .update(a.id)
        .digest("hex")
        .localeCompare(createHash("sha1").update(b.id).digest("hex")),
    );
    ordered.forEach((q, i) => (i % 5 === 1 || i % 5 === 3 ? holdout : dev).add(q.id));
  }
  return { dev, holdout };
}

interface Metrics {
  /** Ana liste bossa ve oneri varsa gosterilen liste "benzer oneriler"dir. */
  suggestionView: boolean;
  mainShown: number;
  ndcg: number | null;
  p10: number;
  mrr: number;
  unjudged: number;
  shown: number;
  irrelevantShown: number;
  specMismatch: number | null;
  accessory: number | null;
}

function measure(
  q: CachedQuery,
  out: MethodOutput,
  labels: Map<string, number>,
  pool: number[],
  titles: Map<number, string>,
): Metrics {
  const suggestionView = out.main.length === 0 && out.suggestions.length > 0;
  const top = (suggestionView ? out.suggestions : out.main).slice(0, 10);
  const rel = top.map((id) => labels.get(`${q.id}:${id}`));
  const gains = rel.map((r) => r ?? 0);
  const dcg = (rs: number[]) => rs.reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...pool].sort((a, b) => b - a).slice(0, 10));
  const firstRel = gains.findIndex((g) => g >= 2);
  const specs = specTokens(q.parsedText);
  const compact = (s: string) => foldForMatch(s).replace(/[\s\-_./]+/g, "");
  const wantsAcc = queryWantsAccessory(q.parsedText);
  return {
    suggestionView,
    mainShown: Math.min(10, out.main.length),
    ndcg: ideal === 0 ? null : dcg(gains) / ideal,
    p10: gains.filter((g) => g >= 2).length / 10,
    mrr: firstRel < 0 ? 0 : 1 / (firstRel + 1),
    unjudged: rel.filter((r) => r === undefined).length,
    shown: top.length,
    irrelevantShown: rel.filter((r) => r === undefined || r === 0).length,
    specMismatch:
      specs.length === 0 || top.length === 0
        ? null
        : top.filter((id) => !specs.every((s) => compact(titles.get(id) ?? "").includes(s)))
            .length / top.length,
    accessory:
      wantsAcc || top.length === 0
        ? null
        : top.filter((id) => looksLikeAccessory(titles.get(id) ?? "")).length / top.length,
  };
}

interface MethodOutput {
  main: number[];
  suggestions: number[];
}
type Method = (q: CachedQuery) => MethodOutput;

function evaluate(
  queries: readonly CachedQuery[],
  method: Method,
  labels: Map<string, number>,
  pools: Map<string, number[]>,
) {
  const per = queries.map((q) => {
    const titles = new Map<number, string>([
      ...q.lexical.map((l) => [l.productId, l.title] as const),
      ...q.candidates.map((c) => [c.productId, c.title] as const),
    ]);
    return { q, m: measure(q, method(q), labels, pools.get(q.id) ?? [], titles) };
  });
  const judged = per.filter((p) => p.m.ndcg !== null);
  const absent = per.filter((p) => p.m.ndcg === null);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const r = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  return {
    per,
    summary: {
      judged: judged.length,
      ndcg10: r(avg(judged.map((p) => p.m.ndcg ?? 0))),
      p10: r(avg(judged.map((p) => p.m.p10))),
      mrr: r(avg(judged.map((p) => p.m.mrr))),
      unjudged_in_top10: judged.reduce((s, p) => s + p.m.unjudged, 0),
      empty_judged: judged.filter((p) => p.m.shown === 0).length,
      absent_queries: absent.length,
      absent_irrelevant_shown_mean: r(avg(absent.map((p) => p.m.irrelevantShown))),
      absent_irrelevant_as_results_mean: r(
        avg(absent.map((p) => (p.m.suggestionView ? 0 : p.m.irrelevantShown))),
      ),
      absent_suggestion_view: absent.filter((p) => p.m.suggestionView).length,
      absent_empty: absent.filter((p) => p.m.shown === 0).length,
      judged_suggestion_view: judged.filter((p) => p.m.suggestionView).length,
      spec_mismatch_rate: r(
        avg(per.map((p) => p.m.specMismatch).filter((x): x is number => x !== null)),
      ),
      accessory_rate: r(avg(per.map((p) => p.m.accessory).filter((x): x is number => x !== null))),
    },
  };
}

function* grid(): Generator<HybridPolicy> {
  for (const strongMinExact of [3, 5, 8])
    for (const strongKeep of [3, 5, 10])
      for (const strongMinOverLexical of [null, 0, 0.05])
        for (const semanticWeight of [0.5, 0.75, 1])
          for (const maxGapFromBest of [0.04, 0.08, 0.12])
            for (const maxSemanticOnly of [5, 10, 20])
              for (const strongMaxGapToDense of [null, 0.1, 0.15, 0.25])
                yield {
                  ...BGE_M3_HYBRID_POLICY,
                  strongMinExact,
                  strongKeep,
                  strongMinOverLexical,
                  semanticWeight,
                  maxGapFromBest,
                  maxSemanticOnly,
                  strongMaxGapToDense,
                  emptyMinTop: null,
                };
}

async function main() {
  const [cachePath, scoresPath, keyPath, outDir] = process.argv.slice(2);
  const hnswArg = process.argv.indexOf("--hnsw");
  const db = createDatabase(process.env.DATABASE_URL ?? "");
  const lexicon = await loadLexiconCached(db);
  const labels = loadLabels(scoresPath ?? "", keyPath ?? "");
  const pools = new Map<string, number[]>();
  for (const [k, v] of labels) {
    const qid = k.split(":")[0] ?? "";
    pools.set(qid, [...(pools.get(qid) ?? []), v]);
  }
  const exact = read(cachePath ?? "");
  const { dev, holdout } = split(exact.queries);
  const checks = new Map(
    exact.queries.map((q) => [q.id, buildCandidateCheck(q.parsedText, lexicon)]),
  );

  const lexicalOnly: Method = (q) => ({ main: q.lexical.map((l) => l.productId), suggestions: [] });
  const oldHybrid: Method = (q) => {
    const sims = new Map(
      q.lexical
        .filter((l) => l.similarity !== null)
        .map((l) => [l.productId, l.similarity as number]),
    );
    return {
      main: fuseForQuery(q.lexical, q.candidates, q.parsedText, sims).fused.map(
        (e) => e.item.productId,
      ),
      suggestions: [],
    };
  };
  const policyMethod =
    (p: HybridPolicy): Method =>
    (q) => {
      const res = conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, p);
      return {
        main: res.ranked.map((e) => e.productId),
        suggestions: res.suggestions.map((c) => c.productId),
      };
    };

  const subset = (ids: Set<string>, data = exact) => data.queries.filter((q) => ids.has(q.id));
  // Gosterilen listenin nDCG'si; yok sorgularinda ilgisizi SONUC gibi gostermenin cezasi.
  const objective = (s: ReturnType<typeof evaluate>["summary"]) =>
    (s.ndcg10 ?? 0) - 0.1 * ((s.absent_irrelevant_as_results_mean ?? 0) / 10);

  const scored: { policy: HybridPolicy; obj: number; s: ReturnType<typeof evaluate>["summary"] }[] =
    [];
  for (const policy of grid()) {
    const s = evaluate(subset(dev), policyMethod(policy), labels, pools).summary;
    scored.push({ policy, obj: objective(s), s });
  }
  scored.sort((a, b) => b.obj - a.obj);
  const chosen = scored[0]!.policy;

  const report: Record<string, unknown> = {
    label_status: "AI destekli on degerlendirme; insan dogrulamasi YOK",
    split: { dev: [...dev].sort(), holdout: [...holdout].sort() },
    grid_size: scored.length,
    objective: "dev nDCG@10 - 0,1 x (yok sorgularinda gosterilen ilgisiz urun / 10)",
    top_configs_dev: scored
      .slice(0, 8)
      .map((x) => ({ obj: Math.round(x.obj * 1000) / 1000, ...x.policy, ...x.s })),
    default_policy_dev: evaluate(subset(dev), policyMethod(BGE_M3_HYBRID_POLICY), labels, pools)
      .summary,
    chosen,
  };
  const methods: [string, Method][] = [
    ["lexical", lexicalOnly],
    ["old_hybrid", oldHybrid],
    ["new_hybrid", policyMethod(chosen)],
  ];
  const lists: Record<string, Record<string, number[]>> = {};
  for (const [setName, ids] of [
    ["dev", dev],
    ["holdout", holdout],
    ["all", new Set(exact.queries.map((q) => q.id))],
  ] as const) {
    const block: Record<string, unknown> = {};
    for (const [name, m] of methods) block[name] = evaluate(subset(ids), m, labels, pools).summary;
    report[`exact_${setName}`] = block;
  }
  // sorgu bazinda kazanc/kayip (exact, tum sorgular)
  const perOld = evaluate(exact.queries, oldHybrid, labels, pools).per;
  const perNew = evaluate(exact.queries, policyMethod(chosen), labels, pools).per;
  const perLex = evaluate(exact.queries, lexicalOnly, labels, pools).per;
  report.per_query = exact.queries.map((q, i) => ({
    id: q.id,
    query: q.query,
    set: holdout.has(q.id) ? "holdout" : "dev",
    mode: conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, chosen).mode,
    lexical: perLex[i]!.m,
    old_hybrid: perOld[i]!.m,
    new_hybrid: perNew[i]!.m,
  }));
  for (const [name, m] of methods) {
    lists[name] = Object.fromEntries(exact.queries.map((q) => [q.id, m(q).main.slice(0, 10)]));
  }
  lists.suggestions = Object.fromEntries(
    exact.queries.map((q) => [
      q.id,
      conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, chosen)
        .suggestions.slice(0, 10)
        .map((c) => c.productId),
    ]),
  );
  // ANN (HNSW) onbellekleriyle ayni politika
  if (hnswArg > 0) {
    for (const path of (process.argv[hnswArg + 1] ?? "").split(",")) {
      const data = read(path);
      const lat = (JSON.parse(readFileSync(path, "utf8")) as { candidate_latency_ms: unknown })
        .candidate_latency_ms;
      for (const q of data.queries) checks.set(q.id, buildCandidateCheck(q.parsedText, lexicon));
      const block: Record<string, unknown> = { candidate_latency_ms: lat };
      for (const [setName, ids] of [
        ["holdout", holdout],
        ["all", new Set(data.queries.map((q) => q.id))],
      ] as const) {
        block[setName] = {
          old_hybrid: evaluate(subset(ids, data), oldHybrid, labels, pools).summary,
          new_hybrid: evaluate(subset(ids, data), policyMethod(chosen), labels, pools).summary,
        };
      }
      report[`hnsw_ef${data.ef}`] = block;
      lists[`new_hybrid_ef${data.ef}`] = Object.fromEntries(
        data.queries.map((q) => [q.id, policyMethod(chosen)(q).main.slice(0, 10)]),
      );
    }
  }
  mkdirSync(outDir ?? ".", { recursive: true });
  writeFileSync(join(outDir ?? ".", "hybrid-tune.json"), JSON.stringify(report, null, 1));
  writeFileSync(join(outDir ?? ".", "hybrid-lists.json"), JSON.stringify(lists));
  const { per_query: _p, top_configs_dev: top, ...head } = report;
  console.log(
    JSON.stringify({ ...head, top_configs_dev: (top as unknown[]).slice(0, 3) }, null, 1),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
