/**
 * E4b C+ v3 degerlendirmesi (YALNIZ yerel; ucretli cagri YAPMAZ; mevcut 120 Gemini kaydini kullanir).
 *
 *   DATABASE_URL=...127.0.0.1... node --experimental-transform-types scripts/e4b-cplus-v3.ts \
 *       <prepare.json> <cache.json> <vectors.json> <rawsim.json> <puanlar.csv> <anahtar.csv> <out.json>
 *
 * Yontemler (ayni urun havuzu ve BGE-M3 vektorleri; urun embedding'i dil basina URETILMEZ):
 *   A   mevcut kosullu hybrid, ham sorgu (degismez taban)
 *   B   C+ v2: ham + v2 dogrulayicisindan gecen yazimlarin lexical'i ARALANARAK birlesir, adaylar birlesir
 *   C   C+ v2 birlestirmesi + v3 dogrulayicisi (urun turu kaniti, rol, birim, marka/ozellik uydurma)
 *   D   ham sorguyu koruyan kosullu genisletme (v3 yazimlari): ham lexical listesi ve sirasi DEGISMEZ;
 *       yazimlarin LEXICAL sonuclari ham listenin ARKASINA eklenir (hicbir ham lexical sonucun onune
 *       gecemez), aday temizliginden gecer ve HAM sorgu vektorune benzerligi mevcut politika penceresi
 *       (`maxGapFromBest`, yeni esik degil) icinde olmalidir. Anlamsal adaylar ham sorgudan.
 *   Dw  D, ham benzerlik penceresi olmadan — pencerenin etkisi.
 *   D0  yalniz aday genisletme: yazimlarin buldugu urunler anlamsal aday olarak, HAM vektorle puanlanir.
 *   Dm  D0 havuzu, aday puani max(ham, yazim) benzerligi — yazim benzerliginin SIRALAMA etkisi.
 * Puanlar AI destekli on degerlendirmedir; puanlanmamis urun 0 SAYILMAZ (yogun/condensed metrik).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import {
  guessTitleLanguage,
  type MultilingualFields,
} from "../src/intent/multilingual-experiment.ts";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import { looksLikeAccessory } from "../src/search/semantic/accessory-guard.ts";
import {
  BGE_M3_HYBRID_POLICY,
  buildCandidateCheck,
  type CandidateCheck,
  conditionalHybrid,
  type PolicyCandidate,
  rejectReason,
} from "../src/search/semantic/hybrid-policy.ts";
import {
  type CanonicalContext,
  type InterpretationEvidence,
  verifyCanonicalQuery,
  verifyRewriteSet,
} from "../src/search/semantic/rewrite-guard.ts";
import { foldForMatch } from "../src/search/text-match.ts";
import type { CachedQuery } from "./bge-tune.ts";
import { loadLabels } from "./e4-labels.ts";

const HB_MIN = 2769499;
const HB_MAX = 2771515;

interface Prepared {
  id: string;
  query: string;
  group: string;
  fields: MultilingualFields | null;
  intent: {
    confidence: string;
    downgraded: boolean;
    role: string | null;
    criteria: { field: string; value: string; canonical: string | null; source: string }[];
  } | null;
  usage: {
    latencyMs: number | null;
    usdMicros: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
}

const cosine = (a: readonly number[], b: readonly number[]) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return d / Math.sqrt(na * nb);
};
const lang = (tag: string) => tag.toLowerCase().split("-")[0] ?? "und";
const dcg = (rs: number[]) => rs.reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);

function interpretationOf(p: Prepared): InterpretationEvidence | undefined {
  if (!p.intent) return undefined;
  const pt = p.intent.criteria.find((c) => c.field === "product_type");
  return {
    productType: pt ? { value: pt.value, source: pt.source } : null,
    role: p.intent.role,
    confidence: p.intent.confidence,
    downgraded: p.intent.downgraded,
    explicitAttributeIds: p.intent.criteria
      .filter((c) => c.field === "attribute" && c.source === "explicit" && c.canonical)
      .map((c) => c.canonical as string),
  };
}

async function main() {
  const [prepP, cacheP, vecP, rawsimP, scoresP, keyP, outP] = process.argv.slice(2);
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error("yalniz yerel degerlendirme veritabani");
  const lexicon = await loadLexiconCached(createDatabase(url));
  const brands = [...new Set(lexicon.filter((e) => e.kind === "brand").map((e) => e.surface))];
  const prepared = JSON.parse(readFileSync(prepP ?? "", "utf8")) as Prepared[];
  const cache = new Map(
    (JSON.parse(readFileSync(cacheP ?? "", "utf8")) as { queries: CachedQuery[] }).queries.map(
      (q) => [q.id, q],
    ),
  );
  const vectors = (
    JSON.parse(readFileSync(vecP ?? "", "utf8")) as { vectors: Record<string, number[]> }
  ).vectors;
  const rawsim = JSON.parse(readFileSync(rawsimP ?? "", "utf8")) as Record<
    string,
    Record<string, number>
  >;
  const labels = loadLabels(scoresP ?? "", keyP ?? "");
  const pools = new Map<string, number[]>();
  for (const [k, v] of labels) {
    const qid = k.split(":")[0] ?? "";
    pools.set(qid, [...(pools.get(qid) ?? []), v]);
  }
  const titleOf = new Map<number, string>();
  for (const c of cache.values()) {
    for (const l of c.lexical) titleOf.set(l.productId, l.title);
    for (const x of c.candidates) titleOf.set(x.productId, x.title);
  }

  const rows = [];
  for (const p of prepared) {
    const orig = cache.get(`O:${p.id}`);
    if (!orig) continue;
    const rawVec = vectors[`O:${p.id}`];
    const sims = rawsim[p.id] ?? {};
    const detected = p.fields?.detected_language ?? { tag: "und", confidence: "low" };
    const excluded = p.fields?.excluded_features ?? [];
    const required = (p.intent?.criteria ?? [])
      .filter((c) => c.field === "brand" && c.source === "explicit")
      .map((c) => c.value);
    const rewrites = p.fields?.search_queries ?? [];
    const cosOf = (rw: { language: string }) => {
      const v = vectors[`R:${p.id}:${lang(rw.language)}`];
      return rawVec && v ? cosine(rawVec, v) : null;
    };
    const base = (rw: { language: string }): CanonicalContext => ({
      lexicon,
      requiredEntities: required,
      crossLingualCosine: cosOf(rw),
    });
    const v2 = rewrites.map((rw) =>
      verifyCanonicalQuery(p.query, detected, rw, excluded, base(rw)),
    );
    const interpretation = interpretationOf(p);
    const v3ctx = (rw: { language: string }): CanonicalContext => ({
      ...base(rw),
      interpretation,
      knownBrands: brands,
    });
    const v3 = verifyRewriteSet(p.query, detected, rewrites, excluded, v3ctx);
    const v3nocos = verifyRewriteSet(p.query, detected, rewrites, excluded, (rw) => ({
      ...v3ctx(rw),
      crossLingualCosine: null,
    }));
    const accepted = (verdicts: { accepted: boolean }[]) =>
      rewrites.filter((_, i) => verdicts[i]?.accepted).map((rw) => lang(rw.language));
    const acc2 = accepted(v2);
    const acc3 = accepted(v3.map((x) => x.verdict));
    const verifiedExcluded = v3[0]?.verdict.verifiedExcluded ?? v2[0]?.verifiedExcluded ?? [];

    const baseCheck = buildCandidateCheck(orig.parsedText, lexicon);
    const check: CandidateCheck = {
      ...baseCheck,
      negated: new Set([...baseCheck.negated, ...verifiedExcluded]),
    };
    const view = (res: ReturnType<typeof conditionalHybrid>) =>
      (res.ranked.length
        ? res.ranked.map((e) => e.productId)
        : res.suggestions.map((c) => c.productId)
      ).slice(0, 10);
    const resA = conditionalHybrid(orig.lexical, orig.candidates, check);
    const A = view(resA);
    const srcOf = (langs: string[]) =>
      langs.map((l) => cache.get(`R:${p.id}:${l}`)).filter((x): x is CachedQuery => Boolean(x));

    // C+ v2 birlestirmesi (onceki D): ham ve yazim lexical'i aralanir, ilk 10 alinir.
    const mergeV2 = (langs: string[]) => {
      const sources = [orig, ...srcOf(langs)];
      const lex: CachedQuery["lexical"] = [];
      const seen = new Set<number>();
      for (let i = 0; i < 10; i++) {
        for (const [si, s] of sources.entries()) {
          const item = s.lexical[i];
          if (item && si > 0 && rejectReason(item.title, check) !== null) continue;
          if (item && !seen.has(item.productId)) {
            seen.add(item.productId);
            lex.push(item);
          }
        }
      }
      const cand = new Map<number, PolicyCandidate>();
      for (const s of sources)
        for (const c of s.candidates) {
          const prev = cand.get(c.productId);
          if (!prev || c.similarity > prev.similarity) cand.set(c.productId, c);
        }
      return view(conditionalHybrid(lex.slice(0, 10), [...cand.values()], check));
    };

    // D: ham lexical sabit; yazimlarin buldugu urunler yalniz anlamsal aday, HAM vektorle puanlanir.
    const expandedPool = (langs: string[], scoring: "raw" | "max") => {
      const rawLex = new Set(orig.lexical.map((l) => l.productId));
      const cand = new Map<number, PolicyCandidate>();
      for (const c of orig.candidates) cand.set(c.productId, c);
      for (const s of srcOf(langs)) {
        for (const item of [
          ...s.lexical.map((l) => ({ ...l, similarity: l.similarity ?? 0 })),
          ...s.candidates,
        ]) {
          if (rawLex.has(item.productId)) continue;
          const raw = sims[String(item.productId)];
          if (raw === undefined) continue;
          const score = scoring === "raw" ? raw : Math.max(raw, item.similarity ?? 0);
          const prev = cand.get(item.productId);
          if (!prev || score > prev.similarity)
            cand.set(item.productId, {
              productId: item.productId,
              title: item.title,
              similarity: score,
            });
        }
      }
      return [...cand.values()];
    };
    const expanded = (langs: string[], gated: boolean, scoring: "raw" | "max") => {
      if (langs.length === 0 || (gated && resA.mode === "lexical_strong"))
        return { ids: A, expandedUsed: false };
      return {
        ids: view(conditionalHybrid(orig.lexical, expandedPool(langs, scoring), check)),
        expandedUsed: true,
      };
    };
    const B = mergeV2(acc2);
    const C = mergeV2(acc3);
    const D0 = expanded(acc3, false, "raw");
    const Dm = expanded(acc3, false, "max");
    const rawBest = Math.max(...orig.candidates.map((c) => c.similarity), Number.NEGATIVE_INFINITY);
    const appended = (langs: string[], window: boolean) => {
      if (langs.length === 0) return { ids: A, expandedUsed: false, added: 0 };
      const seen = new Set(orig.lexical.map((l) => l.productId));
      const extra: CachedQuery["lexical"] = [];
      for (const s of srcOf(langs)) {
        for (const item of s.lexical) {
          if (seen.has(item.productId) || rejectReason(item.title, check) !== null) continue;
          const raw = sims[String(item.productId)];
          if (raw === undefined) continue;
          if (window && raw < rawBest - BGE_M3_HYBRID_POLICY.maxGapFromBest) continue;
          seen.add(item.productId);
          // Eklenen urun "guclu lexical" kararini etkilemez (tier null), benzerligi HAM vektorden.
          extra.push({ ...item, tier: null, similarity: raw });
        }
      }
      const res = conditionalHybrid(
        orig.lexical,
        orig.candidates,
        check,
        BGE_M3_HYBRID_POLICY,
        extra,
      );
      return { ids: view(res), expandedUsed: extra.length > 0, added: extra.length };
    };
    const D = appended(acc3, true);
    const Dw = appended(acc3, false);

    const pool = labels;
    const relevantAll = [...pool.entries()]
      .filter(([k, v]) => k.startsWith(`${p.id}:`) && v >= 2)
      .map(([k]) => Number(k.split(":")[1]));
    const inPool = (ids: Iterable<number>) => {
      const s = new Set(ids);
      return relevantAll.filter((id) => s.has(id)).length;
    };
    const rawPoolIds = [
      ...orig.lexical.map((l) => l.productId),
      ...orig.candidates.map((c) => c.productId),
    ];
    const expPoolIds = [...rawPoolIds, ...expandedPool(acc3, "raw").map((c) => c.productId)];
    const aRel = A.filter((id) => (labels.get(`${p.id}:${id}`) ?? 0) >= 2);
    const aLexExact = A.filter((id) =>
      orig.lexical.some((l) => l.productId === id && l.tier === "exact"),
    );

    const measure = (ids: number[]) => {
      const rel = ids.map((id) => labels.get(`${p.id}:${id}`));
      const judged = rel.filter((r): r is number => r !== undefined);
      const ideal = dcg([...(pools.get(p.id) ?? [])].sort((a, b) => b - a).slice(0, 10));
      const firstJ = judged.findIndex((g) => g >= 2);
      const titles = ids.map((id) => titleOf.get(id) ?? "");
      const compact = (s: string) => foldForMatch(s).replace(/[\s\-_./]+/g, "");
      const set = new Set(ids);
      return {
        // yogun (condensed): puanlanmamis urunler listeden cikarilir, 0 sayilmaz
        ndcgC: ideal ? dcg(judged) / ideal : null,
        p10C: judged.length
          ? judged.filter((g) => g >= 2).length / Math.min(10, judged.length)
          : null,
        mrrC: judged.length ? (firstJ < 0 ? 0 : 1 / (firstJ + 1)) : null,
        // karamsar alt sinir (puanlanmamis = 0); yalniz onceki raporla karsilastirma icin
        ndcgLow: ideal ? dcg(rel.map((r) => r ?? 0)) / ideal : null,
        judged: judged.length,
        shown: ids.length,
        lostRelevant: aRel.filter((id) => !set.has(id)).length,
        lostLexExact: aLexExact.filter((id) => !set.has(id)).length,
        top3Changed: A.slice(0, 3).filter((id) => !ids.slice(0, 3).includes(id)).length,
        jaccardA:
          A.length || ids.length
            ? ids.filter((id) => A.includes(id)).length / new Set([...A, ...ids]).size
            : 1,
        negationViolations: titles.filter((t) =>
          [...check.negated].some((n) => foldForMatch(t).includes(n)),
        ).length,
        specMismatch: check.specs.length
          ? titles.filter((t) => !check.specs.every((s) => compact(t).includes(s))).length
          : null,
        typeMismatch: check.typePattern
          ? titles.filter((t) => !new RegExp(check.typePattern as string).test(foldForMatch(t)))
              .length
          : null,
        accessory: check.accessoryGuard ? titles.filter((t) => looksLikeAccessory(t)).length : null,
        trTitleHits: ids.filter((id) => id >= HB_MIN && id <= HB_MAX).length,
        resultLanguages: titles.map((t) => guessTitleLanguage(t).tag),
      };
    };
    const verdictView = (vs: { accepted: boolean; reason: string | null }[]) =>
      Object.fromEntries(
        rewrites.map((rw, i) => [
          lang(rw.language),
          { accepted: vs[i]?.accepted ?? false, reason: vs[i]?.reason ?? null, text: rw.text },
        ]),
      );
    rows.push({
      id: p.id,
      query: p.query,
      group: p.group,
      lang: p.group.split("/")[0],
      detected,
      modeA: resA.mode,
      v2: verdictView(v2),
      v3: verdictView(v3.map((x) => x.verdict)),
      v3nocos: verdictView(v3nocos.map((x) => x.verdict)),
      cosines: Object.fromEntries(rewrites.map((rw) => [lang(rw.language), cosOf(rw)])),
      usage: p.usage,
      poolRecall: {
        relevant: relevantAll.length,
        raw: inPool(rawPoolIds),
        expanded: inPool(expPoolIds),
      },
      expandedUsed: { D: D.expandedUsed, Dw: Dw.expandedUsed, D0: D0.expandedUsed },
      added: { D: D.added, Dw: Dw.added },
      A: { ids: A, m: measure(A) },
      B: { ids: B, m: measure(B) },
      C: { ids: C, m: measure(C) },
      D: { ids: D.ids, m: measure(D.ids) },
      Dw: { ids: Dw.ids, m: measure(Dw.ids) },
      D0: { ids: D0.ids, m: measure(D0.ids) },
      Dm: { ids: Dm.ids, m: measure(Dm.ids) },
    });
  }
  writeFileSync(outP ?? "", JSON.stringify(rows, null, 1));
  console.log(`degerlendirildi: ${rows.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
