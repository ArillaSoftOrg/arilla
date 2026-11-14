/**
 * E4b C+ degerlendirmesi (YALNIZ yerel; ucretli cagri YAPMAZ, `gemini.jsonl` kayitlarini kullanir).
 *
 *   prepare <gemini.jsonl> <queries.tsv> <out-dir>        -> prepare.json, texts.tsv
 *   eval    <out-dir> <texts-cache.json> <vectors.json> <puanlar.csv> <anahtar.csv>
 *
 * Yontemler (ayni urun havuzu, ayni BGE-M3 vektorleri; urun embedding'i dil basina URETILMEZ):
 *   A  mevcut kosullu hybrid, ham sorgu
 *   B  lexical, dogrulanmis EN yazim (yoksa ham sorgu)
 *   C  dense (korumali aday SQL'i), dogrulanmis EN yazim vektoru (yoksa ham)
 *   D  C+ hybrid: ham + dogrulanmis TUM katalog dili yazimlarinin lexical ve anlamsal adaylari
 *      birlesir; denetim (teknik kod, olumsuzluk) HAM sorgudan + kanitli dislamalar.
 * AI destekli etiketler yalniz on degerlendirmedir; etiketsiz sorgularda kalite puani URETILMEZ.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@arilla/db";
import { fromRawQuery } from "../src/intent/normalized-query-adapter.ts";
import {
  guessTitleLanguage,
  type MultilingualFields,
  parseMultilingualFields,
} from "../src/intent/multilingual-experiment.ts";
import { validateIntentV2 } from "../src/intent/validate.ts";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import { looksLikeAccessory } from "../src/search/semantic/accessory-guard.ts";
import {
  buildCandidateCheck,
  type CandidateCheck,
  conditionalHybrid,
  rejectReason,
} from "../src/search/semantic/hybrid-policy.ts";
import { verifyCanonicalQuery } from "../src/search/semantic/rewrite-guard.ts";
import { foldForMatch } from "../src/search/text-match.ts";
import type { CachedQuery } from "./bge-tune.ts";
import { loadLabels } from "./e4-labels.ts";

const HB_MIN = 2769499;
const HB_MAX = 2771515;

interface GeminiRec {
  id: string;
  query: string;
  group: string;
  status: string;
  attempts: number;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  usdMicros: number;
  raw: unknown;
}

const readJsonl = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GeminiRec);

function langGroup(group: string): string {
  return group.split("/")[0] ?? group;
}

async function prepare(geminiPath: string, queriesPath: string, outDir: string) {
  const db = createDatabase(process.env.DATABASE_URL ?? "");
  const lexicon = await loadLexiconCached(db);
  const recs = readJsonl(geminiPath);
  const queries = readFileSync(queriesPath, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const byId = new Map(recs.map((r) => [r.id, r]));
  const prepared = [];
  const texts: string[] = ["id\tquery\tgroup"];
  for (const [id = "", q = "", group = ""] of queries) {
    texts.push(`O:${id}\t${q}\t${group}`);
    const rec = byId.get(id);
    const fields = rec?.status === "ok" ? parseMultilingualFields(rec.raw) : null;
    let intent: ReturnType<typeof validateIntentV2> | null = null;
    let intentError: string | null = null;
    if (rec?.status === "ok") {
      try {
        intent = validateIntentV2(rec.raw, { query: fromRawQuery(q), lexicon });
      } catch (e) {
        intentError = e instanceof Error ? e.name : "error";
      }
    }
    for (const rw of fields?.search_queries ?? []) {
      const lang = rw.language.toLowerCase().split("-")[0] ?? "und";
      texts.push(`R:${id}:${lang}\t${rw.text.replaceAll("\t", " ")}\t${group}`);
    }
    prepared.push({
      id,
      query: q,
      group,
      status: rec?.status ?? "not_called",
      fields,
      intent: intent && {
        confidence: intent.confidence,
        downgraded: intent.downgraded,
        role: intent.role,
        budget: intent.budget,
        criteria: intent.criteria.map((c) => ({
          field: c.field,
          value: c.value,
          canonical: c.canonical,
          source: c.source,
          mode: c.mode,
          strength: c.strength,
          reason: c.reason,
        })),
      },
      intentError,
      usage: rec
        ? {
            attempts: rec.attempts,
            latencyMs: rec.latencyMs,
            inputTokens: rec.inputTokens,
            outputTokens: rec.outputTokens,
            usdMicros: rec.usdMicros,
          }
        : null,
    });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "prepare.json"), JSON.stringify(prepared, null, 1));
  writeFileSync(join(outDir, "texts.tsv"), `${texts.join("\n")}\n`);
  console.log(`hazirlandi: ${prepared.length} sorgu, ${texts.length - 1} metin`);
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

interface Prepared {
  id: string;
  query: string;
  group: string;
  status: string;
  fields: MultilingualFields | null;
  intent: {
    confidence: string;
    downgraded: boolean;
    role: string | null;
    budget: unknown;
    criteria: {
      field: string;
      value: string;
      canonical: string | null;
      source: string;
      mode: string;
      strength?: string;
      reason: string;
    }[];
  } | null;
  intentError: string | null;
  usage: { attempts: number; latencyMs: number | null; inputTokens: number; outputTokens: number; usdMicros: number } | null;
}

async function evaluate(outDir: string, cachePath: string, vectorsPath: string, scoresP: string, keyP: string) {
  const db = createDatabase(process.env.DATABASE_URL ?? "");
  const lexicon = await loadLexiconCached(db);
  const prepared = JSON.parse(readFileSync(join(outDir, "prepare.json"), "utf8")) as Prepared[];
  const cache = new Map(
    (JSON.parse(readFileSync(cachePath, "utf8")) as { queries: CachedQuery[] }).queries.map((q) => [q.id, q]),
  );
  const vectors = (JSON.parse(readFileSync(vectorsPath, "utf8")) as { vectors: Record<string, number[]> }).vectors;
  const labels = loadLabels(scoresP, keyP);
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
  const dcg = (rs: number[]) => rs.reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);

  const rows = [];
  for (const p of prepared) {
    const orig = cache.get(`O:${p.id}`);
    if (!orig) continue;
    const rawVec = vectors[`O:${p.id}`];
    const required = (p.intent?.criteria ?? [])
      // Yalniz dilden bagimsiz ozel adlar (marka); cevrilebilen sozcukler degil.
      .filter((c) => c.field === "brand" && c.source === "explicit")
      .map((c) => c.value);
    const verdicts: Record<string, { accepted: boolean; reason: string | null; cosine: number | null; text: string }> = {};
    let verifiedExcluded: string[] = [];
    let negationCheck: string | null = null;
    for (const rw of p.fields?.search_queries ?? []) {
      const lang = rw.language.toLowerCase().split("-")[0] ?? "und";
      const vec = vectors[`R:${p.id}:${lang}`];
      const cos = rawVec && vec ? cosine(rawVec, vec) : null;
      const v = verifyCanonicalQuery(
        p.query,
        p.fields?.detected_language ?? { tag: "und", confidence: "low" },
        rw,
        p.fields?.excluded_features ?? [],
        { lexicon, requiredEntities: required, crossLingualCosine: cos },
      );
      verdicts[lang] = { accepted: v.accepted, reason: v.reason, cosine: cos === null ? null : Math.round(cos * 1000) / 1000, text: rw.text };
      verifiedExcluded = v.verifiedExcluded;
      negationCheck = v.negationCheck;
    }
    // Denetim HAM sorgudan; kanitli dislamalar olumsuzlanan terimlere eklenir.
    const baseCheck = buildCandidateCheck(orig.parsedText, lexicon);
    const check: CandidateCheck = {
      ...baseCheck,
      negated: new Set([...baseCheck.negated, ...verifiedExcluded]),
    };
    const acceptedLangs = Object.entries(verdicts).filter(([, v]) => v.accepted).map(([l]) => l);
    const rewriteCache = (lang: string) => (acceptedLangs.includes(lang) ? cache.get(`R:${p.id}:${lang}`) : undefined);
    const en = rewriteCache("en");
    const view = (res: ReturnType<typeof conditionalHybrid>) =>
      (res.ranked.length ? res.ranked.map((e) => e.productId) : res.suggestions.map((c) => c.productId)).slice(0, 10);
    const A = view(conditionalHybrid(orig.lexical, orig.candidates, check));
    const B = (en ?? orig).lexical.map((l) => l.productId).slice(0, 10);
    const C = [...(en ?? orig).candidates].sort((a, b) => b.similarity - a.similarity).map((c) => c.productId).slice(0, 10);
    // D: ham + kabul edilen tum yazimlar
    const sources = [orig, ...acceptedLangs.map((l) => cache.get(`R:${p.id}:${l}`)).filter((x): x is CachedQuery => Boolean(x))];
    const lexMerged: CachedQuery["lexical"] = [];
    const seenLex = new Set<number>();
    for (let i = 0; i < 10; i++) {
      for (const [si, s] of sources.entries()) {
        const item = s.lexical[i];
        // Yazimdan gelen lexical sonuc kullanicinin metni degildir: anlamsal aday gibi temizlenir.
        if (item && si > 0 && rejectReason(item.title, check) !== null) continue;
        if (item && !seenLex.has(item.productId)) {
          seenLex.add(item.productId);
          lexMerged.push(item);
        }
      }
    }
    const candMap = new Map<number, CachedQuery["candidates"][number]>();
    for (const s of sources) {
      for (const c of s.candidates) {
        const prev = candMap.get(c.productId);
        if (!prev || c.similarity > prev.similarity) candMap.set(c.productId, c);
      }
    }
    const D = view(conditionalHybrid(lexMerged.slice(0, 10), [...candMap.values()], check));

    const measure = (ids: number[]) => {
      const rel = ids.map((id) => labels.get(`${p.id}:${id}`));
      const ideal = dcg([...(pools.get(p.id) ?? [])].sort((a, b) => b - a).slice(0, 10));
      const gains = rel.map((r) => r ?? 0);
      const first = gains.findIndex((g) => g >= 2);
      const titles = ids.map((id) => titleOf.get(id) ?? "");
      const negViol = titles.filter((t) => [...check.negated].some((n) => foldForMatch(t).includes(n))).length;
      const specs = check.specs;
      const compact = (s: string) => foldForMatch(s).replace(/[\s\-_./]+/g, "");
      return {
        ndcg: ideal ? dcg(gains) / ideal : null,
        p10: gains.filter((g) => g >= 2).length / 10,
        mrr: first < 0 ? 0 : 1 / (first + 1),
        unjudged: rel.filter((r) => r === undefined).length,
        shown: ids.length,
        negationViolations: negViol,
        specMismatch: specs.length ? titles.filter((t) => !specs.every((s) => compact(t).includes(s))).length : null,
        typeMismatch: check.typePattern ? titles.filter((t) => !new RegExp(check.typePattern as string).test(foldForMatch(t))).length : null,
        accessory: check.accessoryGuard ? titles.filter((t) => looksLikeAccessory(t)).length : null,
        trTitleHits: ids.filter((id) => id >= HB_MIN && id <= HB_MAX).length,
        resultLanguages: titles.map((t) => guessTitleLanguage(t).tag),
      };
    };
    rows.push({
      id: p.id,
      query: p.query,
      group: p.group,
      lang: langGroup(p.group),
      status: p.status,
      detected: p.fields?.detected_language ?? null,
      intentConfidence: p.intent?.confidence ?? null,
      intentCriteria: p.intent?.criteria.length ?? 0,
      intentError: p.intentError,
      verdicts,
      verifiedExcluded,
      negationCheck,
      usage: p.usage,
      A: { ids: A, m: measure(A) },
      B: { ids: B, m: measure(B) },
      C: { ids: C, m: measure(C) },
      D: { ids: D, m: measure(D) },
    });
  }
  writeFileSync(join(outDir, "eval.json"), JSON.stringify(rows, null, 1));
  console.log(`degerlendirildi: ${rows.length}`);
}

const [mode, ...args] = process.argv.slice(2);
const run =
  mode === "prepare"
    ? prepare(args[0] ?? "", args[1] ?? "", args[2] ?? "")
    : mode === "eval"
      ? evaluate(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3] ?? "", args[4] ?? "")
      : Promise.reject(new Error("mod: prepare | eval"));
run
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
