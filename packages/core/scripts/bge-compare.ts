/**
 * E4-b: A (mevcut kosullu hybrid) ile B0 (lexical guven sinyalleri: tur tutarliligi, teknik kod,
 * lexical-anlamsal uyum) karsilastirmasi. B0 parametreleri YALNIZ eski gelistirme kumesinde secilir;
 * eski dogrulama kumesi ve GORULMEMIS sorgular ayrica olculur. Gorulmemis sorgularda alaka etiketi
 * YOKTUR: yalniz etiketsiz gostergeler raporlanir ve kor etiketleme havuzu uretilir.
 *
 *   node --experimental-transform-types scripts/bge-compare.ts <cache-exact> <cache-ef150> \
 *     <unseen-exact> <unseen-ef150> <puanlar.csv> <anahtar.csv> <cikti-dizini>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@arilla/db";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import { looksLikeAccessory } from "../src/search/semantic/accessory-guard.ts";
import {
  BGE_M3_HYBRID_POLICY,
  buildCandidateCheck,
  type CandidateCheck,
  conditionalHybrid,
  type HybridPolicy,
} from "../src/search/semantic/hybrid-policy.ts";
import { foldForMatch } from "../src/search/text-match.ts";
import { type CachedQuery, evaluate, type Method, read, split } from "./bge-tune.ts";
import { loadLabels } from "./e4-labels.ts";

function* b0Grid(base: HybridPolicy): Generator<HybridPolicy> {
  for (const minLexTypeShare of [null, 0.5, 0.8])
    for (const lexTypeMismatchFactor of [1, 0.5, 0.3])
      for (const lexSpecMissingFactor of [1, 0.5])
        for (const strongMinAgreement of [null, 2, 3])
          yield {
            ...base,
            minLexTypeShare,
            lexTypeMismatchFactor,
            lexSpecMissingFactor,
            strongMinAgreement,
          };
}

const compact = (s: string) => foldForMatch(s).replace(/[\s\-_./]+/g, "");
const contains = (title: string, phrase: string) =>
  new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(
    foldForMatch(title),
  );

/** Etiketsiz gostergeler (gorulmemis sorgular). */
function proxies(
  queries: readonly CachedQuery[],
  checks: Map<string, CandidateCheck>,
  method: Method,
) {
  let specQ = 0,
    specBad = 0,
    specN = 0;
  let typeQ = 0,
    typeBad = 0,
    typeN = 0;
  let negQ = 0,
    negBad = 0;
  let accN = 0,
    accBad = 0;
  let keep3 = 0,
    keep3Q = 0,
    suggestion = 0,
    emptyMain = 0;
  for (const q of queries) {
    const out = method(q);
    const view = (out.main.length ? out.main : out.suggestions).slice(0, 10);
    if (!out.main.length) emptyMain++;
    if (!out.main.length && out.suggestions.length) suggestion++;
    const titles = new Map<number, string>([
      ...q.lexical.map((l) => [l.productId, l.title] as const),
      ...q.candidates.map((c) => [c.productId, c.title] as const),
    ]);
    const check = checks.get(q.id)!;
    const t = (id: number) => titles.get(id) ?? "";
    if (check.specs.length && view.length) {
      specQ++;
      specN += view.length;
      specBad += view.filter((id) => !check.specs.every((s) => compact(t(id)).includes(s))).length;
    }
    if (check.typePattern && view.length) {
      const re = new RegExp(check.typePattern);
      typeQ++;
      typeN += view.length;
      typeBad += view.filter((id) => !re.test(foldForMatch(t(id)))).length;
    }
    if (check.negated.size && view.length) {
      negQ++;
      negBad += view.filter((id) => [...check.negated].some((n) => contains(t(id), n))).length;
    }
    if (check.accessoryGuard) {
      accN += view.length;
      accBad += view.filter((id) => looksLikeAccessory(t(id))).length;
    }
    const lex3 = q.lexical.slice(0, 3).map((l) => l.productId);
    if (lex3.length) {
      keep3Q++;
      keep3 += lex3.filter((id) => out.main.slice(0, 3).includes(id)).length / lex3.length;
    }
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    queries: queries.length,
    spec_mismatch_rate: specN ? r(specBad / specN) : null,
    spec_queries: specQ,
    type_mismatch_rate: typeN ? r(typeBad / typeN) : null,
    type_queries: typeQ,
    negation_violations: negBad,
    negation_queries: negQ,
    accessory_rate: accN ? r(accBad / accN) : null,
    lexical_top3_kept: keep3Q ? r(keep3 / keep3Q) : null,
    suggestion_view: suggestion,
    empty_main: emptyMain,
  };
}

async function main() {
  const [exactP, ef150P, uExactP, uEf150P, scoresP, keyP, outDir] = process.argv.slice(2);
  const lexicon = await loadLexiconCached(createDatabase(process.env.DATABASE_URL ?? ""));
  const labels = loadLabels(scoresP ?? "", keyP ?? "");
  const pools = new Map<string, number[]>();
  for (const [k, v] of labels) {
    const qid = k.split(":")[0] ?? "";
    pools.set(qid, [...(pools.get(qid) ?? []), v]);
  }
  const seen = read(exactP ?? "");
  const seenAnn = read(ef150P ?? "");
  const unseen = read(uExactP ?? "");
  const unseenAnn = read(uEf150P ?? "");
  const checks = new Map<string, CandidateCheck>();
  for (const q of [...seen.queries, ...unseen.queries])
    checks.set(q.id, buildCandidateCheck(q.parsedText, lexicon));
  const { dev, holdout } = split(seen.queries);
  const pol =
    (p: HybridPolicy): Method =>
    (q) => {
      const res = conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, p);
      return {
        main: res.ranked.map((e) => e.productId),
        suggestions: res.suggestions.map((c) => c.productId),
      };
    };
  const lexical: Method = (q) => ({ main: q.lexical.map((l) => l.productId), suggestions: [] });
  const sub = (ids: Set<string>, qs: readonly CachedQuery[]) => qs.filter((q) => ids.has(q.id));

  const A = BGE_M3_HYBRID_POLICY;
  const objective = (s: ReturnType<typeof evaluate>["summary"]) =>
    (s.ndcg10 ?? 0) - 0.1 * ((s.absent_irrelevant_as_results_mean ?? 0) / 10);
  const scored = [...b0Grid(A)]
    .map((p) => ({ p, s: evaluate(sub(dev, seen.queries), pol(p), labels, pools).summary }))
    .map((x) => ({ ...x, obj: objective(x.s) }))
    .sort((a, b) => b.obj - a.obj);
  const B0 = scored[0]!.p;
  const baseObj = objective(evaluate(sub(dev, seen.queries), pol(A), labels, pools).summary);

  const block = (qs: readonly CachedQuery[]) => ({
    lexical: evaluate(qs, lexical, labels, pools).summary,
    A: evaluate(qs, pol(A), labels, pools).summary,
    B0: evaluate(qs, pol(B0), labels, pools).summary,
  });
  const perQuery = (qs: readonly CachedQuery[]) => {
    const a = evaluate(qs, pol(A), labels, pools).per;
    const b = evaluate(qs, pol(B0), labels, pools).per;
    const l = evaluate(qs, lexical, labels, pools).per;
    return qs.map((q, i) => ({
      id: q.id,
      query: q.query,
      lexical: l[i]!.m.ndcg,
      A: a[i]!.m.ndcg,
      B0: b[i]!.m.ndcg,
      modeA: conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, A).mode,
      modeB0: conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, B0).mode,
    }));
  };
  const report = {
    label_status:
      "AI destekli on degerlendirme (gorulen sorgular); gorulmemis sorgularda ETIKET YOK",
    B0_grid: scored.length,
    dev_objective: {
      A: Math.round(baseObj * 1000) / 1000,
      B0: Math.round(scored[0]!.obj * 1000) / 1000,
    },
    top_b0_dev: scored.slice(0, 5).map((x) => ({ obj: Math.round(x.obj * 1000) / 1000, ...x.p })),
    B0,
    seen_dev: block(sub(dev, seen.queries)),
    seen_holdout: block(sub(holdout, seen.queries)),
    seen_all_exact: block(seen.queries),
    seen_all_hnsw150: block(seenAnn.queries),
    seen_per_query: perQuery(seen.queries),
    unseen_proxies_exact: {
      lexical: proxies(unseen.queries, checks, lexical),
      A: proxies(unseen.queries, checks, pol(A)),
      B0: proxies(unseen.queries, checks, pol(B0)),
    },
    unseen_proxies_hnsw150: {
      A: proxies(unseenAnn.queries, checks, pol(A)),
      B0: proxies(unseenAnn.queries, checks, pol(B0)),
    },
    unseen_modes: unseen.queries.map((q) => ({
      id: q.id,
      query: q.query,
      lexical: q.lexical.length,
      A: conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, A).mode,
      B0: conditionalHybrid(q.lexical, q.candidates, checks.get(q.id)!, B0).mode,
      differ_top10: (() => {
        const a = pol(A)(q),
          b = pol(B0)(q);
        const va = (a.main.length ? a.main : a.suggestions).slice(0, 10);
        const vb = (b.main.length ? b.main : b.suggestions).slice(0, 10);
        return va.filter((id) => !vb.includes(id)).length;
      })(),
    })),
  };
  // Gorulmemis sorgular icin kor etiketleme havuzu: lexical / A / B0 gosterilen ilk 10
  const pool = unseen.queries.map((q) => {
    const views = [lexical, pol(A), pol(B0)].map((m) => {
      const o = m(q);
      return (o.main.length ? o.main : o.suggestions).slice(0, 10);
    });
    return { id: q.id, query: q.query, lexical: views[0], A: views[1], B0: views[2] };
  });
  mkdirSync(outDir ?? ".", { recursive: true });
  writeFileSync(join(outDir ?? ".", "compare.json"), JSON.stringify(report, null, 1));
  writeFileSync(join(outDir ?? ".", "unseen-pool.json"), JSON.stringify(pool));
  const { seen_per_query: _s, unseen_modes: _u, ...head } = report;
  console.log(JSON.stringify(head, null, 1));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
