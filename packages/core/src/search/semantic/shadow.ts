/**
 * Anlamsal arama GOLGE olcumu (karar 0178). Kullaniciya donen sonuc DEGISMEZ.
 *
 * Arama bittikten sonra arka planda: kisisel veri suzgeci -> gunluk tavan -> sorgu vektoru ->
 * bagimsiz anlamsal adaylar (metinle ayni suzgecler) -> pilotun kapisi ve RRF fuzyonu "acik olsaydi"
 * ilk 10'u nasil degistirirdi -> yalnizca SAYISAL olculer `semantic_shadow_event`'e. Sorgu metni,
 * ozeti ve urun kimlikleri saklanmaz. Hata aramayi asla bozmaz; ama SESSIZCE de yutulmaz (karar
 * 0190): olcu satiri yazilamazsa ya da beklenmeyen bir hata olursa yapisal gunluk satiri
 * (`semantic_shadow_error`, yalniz hata sinifi) yazilir ve surec ici sayac artar.
 */
import { apiUsage, type Database, semanticShadowEvent } from "@arilla/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { costMicrosPerThousandTokens } from "../../embedding/embed-uploaded-image.ts";
import { queryContentIneligibility } from "../interpretation-eligibility.ts";
import { normalizeQueryText } from "../normalize.ts";
import { foldForMatch } from "../text-match.ts";
import type { QueryFilters } from "../types.ts";
import { looksLikeAccessory, queryWantsAccessory } from "./accessory-guard.ts";
import { type IndexResolution, resolveSemanticIndex, type SemanticIndex } from "./active-index.ts";
import {
  DEFAULT_SEMANTIC_GATE,
  SHADOW_MAX_IN_FLIGHT,
  semanticModelVersion,
  semanticSearchMode,
  shadowDailyCap,
  shadowSamplePercent,
} from "./config.ts";
import { fuseResults, gateSemantic } from "./fusion.ts";
import { requiredTypePattern } from "./product-type.ts";
import { createJinaQueryEmbedder, type QueryEmbedder } from "./query-embedder.ts";
import {
  findSemanticCandidates,
  type SemanticCandidate,
  similaritiesFor,
} from "./semantic-candidates.ts";

/** `api_usage.operation`. */
export const SEMANTIC_QUERY_OPERATION = "semantic_query_embedding";

/** Karsilastirmanin kesildigi sira (kullanicinin gordugu ilk ekran). */
export const SHADOW_TOP_N = 10;

export type ShadowOutcome = "measured" | "no_vector" | "ineligible" | "capped" | "error";

export interface ShadowTextItem {
  productId: number;
  title: string;
}

export interface ShadowInput {
  /** Anlamsal olarak embed edilecek metin (suzgece cevrilen kisimlar cikarilmis sorgu). */
  semanticText: string;
  /** Baslik korumalari icin tam sorgu metni. */
  queryText: string;
  filters: QueryFilters;
  /** Kullaniciya gosterilen metin sonucu, sirasiyla. */
  textItems: readonly ShadowTextItem[];
  /** Kullanicinin gordugu sonuc sayisi (sayfa boyu); karsilastirma bu sirada kesilir. */
  topN?: number;
}

export interface ShadowMetrics {
  outcome: ShadowOutcome;
  reason: string | null;
  modelVersion: string;
  textCount: number;
  topN: number;
  textWithVector: number;
  candidateCount: number;
  bestSimilarity: number | null;
  gatePassed: number;
  semanticOnly: number;
  overlapTopN: number;
  newInTopN: number;
  embedMs: number | null;
  knnMs: number | null;
  cacheHit: boolean | null;
}

export interface ShadowDeps {
  env?: Readonly<Record<string, string | undefined>>;
  embedder?: QueryEmbedder | null;
  findCandidates?: typeof findSemanticCandidates;
  /** Aktif indeks cozumleyici (karar 0181); testler sabit indeks verir. */
  resolveIndex?: (db: Database) => Promise<IndexResolution>;
  findSimilarities?: typeof similaritiesFor;
  /** Bugunku gercek (onbellek disi) cagri sayisi. */
  usedToday?: (db: Database) => Promise<number>;
  record?: (db: Database, metrics: ShadowMetrics) => Promise<void>;
  clock?: () => number;
  random?: () => number;
  /** Yapisal hata gunlugu (testler yakalar); varsayilan `console.warn` JSON satiri. */
  logError?: (line: ShadowErrorLine) => void;
}

export interface ShadowErrorLine {
  event: "semantic_shadow_error";
  stage: "record_failed" | "measure_failed" | "unexpected";
  /** Hata sinifi ya da olcu nedeni (sabit kucuk sozluk; mesaj/sorgu metni YOK). */
  reason: string;
}

const shadowErrors = new Map<string, number>();

/** Surec ici golge hata sayaclari (`stage:reason` -> adet). */
export function semanticShadowErrorCounters(): Record<string, number> {
  return Object.fromEntries(shadowErrors);
}

function errorClass(error: unknown): string {
  if (typeof error === "string") return error.slice(0, 40);
  const code =
    (error as { cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `pg_${code}`;
  return (error instanceof Error ? error.name : "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 40);
}

function reportShadowError(
  stage: ShadowErrorLine["stage"],
  error: unknown,
  logError?: (line: ShadowErrorLine) => void,
): void {
  const line: ShadowErrorLine = {
    event: "semantic_shadow_error",
    stage,
    reason: error === null || error === undefined ? "unknown" : errorClass(error),
  };
  const key = `${line.stage}:${line.reason}`;
  shadowErrors.set(key, (shadowErrors.get(key) ?? 0) + 1);
  try {
    (logError ?? ((l) => console.warn(JSON.stringify(l))))(line);
  } catch {
    // Gunluk yazilamazsa da arama etkilenmez.
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function emptyMetrics(
  outcome: ShadowOutcome,
  modelVersion: string,
  textCount: number,
  topN: number,
  reason: string | null = null,
): ShadowMetrics {
  return {
    outcome,
    reason,
    modelVersion,
    textCount,
    topN,
    textWithVector: 0,
    candidateCount: 0,
    bestSimilarity: null,
    gatePassed: 0,
    semanticOnly: 0,
    overlapTopN: 0,
    newInTopN: 0,
    embedMs: null,
    knnMs: null,
    cacheHit: null,
  };
}

function defaultEmbedder(db: Database, env: Env, index: SemanticIndex): QueryEmbedder | null {
  const apiKey = env.JINA_API_KEY?.trim();
  if (!apiKey) return null;
  return createJinaQueryEmbedder(apiKey, index.modelVersion, {
    dimensions: index.dimensions,
    task: index.queryTask,
    onUsage: async (usage) => {
      await db.insert(apiUsage).values({
        sessionId: null,
        userId: null,
        operation: SEMANTIC_QUERY_OPERATION,
        modelVersion: usage.modelVersion,
        units: usage.tokens,
        costMicros: Math.round((usage.tokens * costMicrosPerThousandTokens(env)) / 1000),
        cacheHit: usage.cacheHit,
      });
    },
  });
}

async function defaultUsedToday(db: Database): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(apiUsage)
    .where(
      and(
        gte(apiUsage.createdAt, sql`date_trunc('day', now())`),
        eq(apiUsage.operation, SEMANTIC_QUERY_OPERATION),
        eq(apiUsage.cacheHit, false),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultRecord(db: Database, m: ShadowMetrics): Promise<void> {
  await db.insert(semanticShadowEvent).values({
    outcome: m.outcome,
    reason: m.reason,
    modelVersion: m.modelVersion,
    textCount: m.textCount,
    topN: m.topN,
    textWithVector: m.textWithVector,
    candidateCount: m.candidateCount,
    bestSimilarity: m.bestSimilarity,
    gatePassed: m.gatePassed,
    semanticOnly: m.semanticOnly,
    overlapTopN: m.overlapTopN,
    newInTopN: m.newInTopN,
    embedMs: m.embedMs === null ? null : Math.round(m.embedMs),
    knnMs: m.knnMs === null ? null : Math.round(m.knnMs),
    cacheHit: m.cacheHit,
  });
}

/**
 * "Anlamsal acik olsaydi" karsilastirmasi (saf): pilotun aksesuar/tur korumasi, kapi ve RRF.
 * Metin sonucu hic dusmez; fark yalnizca ilk N'e giren anlamsal-yalniz urunlerdir.
 */
/**
 * "Anlamsal acik olsaydi" sirasi (saf): pilotun aksesuar/tur korumasi, kapi ve RRF. Gölge olcum
 * ve cevrimdisi degerlendirme (`scripts/semantic-eval.ts`) AYNI fonksiyonu kullanir.
 */
export function fuseForQuery<T extends ShadowTextItem>(
  textItems: readonly T[],
  candidates: readonly SemanticCandidate[],
  queryText: string,
  textSimilarity: ReadonlyMap<number, number>,
) {
  const guard = !queryWantsAccessory(queryText);
  const usable = guard ? candidates.filter((c) => !looksLikeAccessory(c.title)) : [...candidates];
  const textIds = new Set(textItems.map((item) => item.productId));
  const passed = gateSemantic(usable, textIds, DEFAULT_SEMANTIC_GATE);
  const typePattern = requiredTypePattern(queryText);
  const typeRegex = typePattern === null ? null : new RegExp(typePattern);
  const fused = fuseResults<ShadowTextItem>([...textItems], usable, {
    gate: DEFAULT_SEMANTIC_GATE,
    textSimilarity,
    ...(guard ? { isAccessory: (item: ShadowTextItem) => looksLikeAccessory(item.title) } : {}),
    ...(typeRegex
      ? { isTypeMismatch: (item: ShadowTextItem) => !typeRegex.test(foldForMatch(item.title)) }
      : {}),
  });
  return { fused, passed, textIds };
}

export function compareTopN(
  textItems: readonly ShadowTextItem[],
  candidates: readonly SemanticCandidate[],
  queryText: string,
  textSimilarity: ReadonlyMap<number, number>,
  topN = SHADOW_TOP_N,
): Pick<ShadowMetrics, "gatePassed" | "semanticOnly" | "overlapTopN" | "newInTopN"> {
  const { fused, passed, textIds } = fuseForQuery(textItems, candidates, queryText, textSimilarity);
  const textTop = new Set(textItems.slice(0, topN).map((item) => item.productId));
  const fusedTop = fused.slice(0, topN);
  return {
    gatePassed: passed.length,
    semanticOnly: passed.filter((c) => !textIds.has(c.productId)).length,
    overlapTopN: fusedTop.filter((entry) => textTop.has(entry.item.productId)).length,
    newInTopN: fusedTop.filter((entry) => entry.source === "semantic").length,
  };
}

/** Tek olcum. Hicbir zaman firlatmaz; kaydedilen olcuyu (ya da orneklem disiysa null) doner. */
export async function measureSemanticShadow(
  db: Database,
  input: ShadowInput,
  deps: ShadowDeps = {},
): Promise<ShadowMetrics | null> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? (() => performance.now());
  const random = deps.random ?? Math.random;
  const record = deps.record ?? defaultRecord;
  let model = semanticModelVersion(env);
  const textCount = input.textItems.length;
  const topN = Math.min(SHADOW_TOP_N, Math.max(1, Math.floor(input.topN ?? SHADOW_TOP_N)));

  const save = async (metrics: ShadowMetrics): Promise<ShadowMetrics> => {
    try {
      await record(db, metrics);
    } catch (error) {
      // Olcum tablosu yazilamazsa da arama etkilenmez; ama gorunur olur.
      reportShadowError("record_failed", error, deps.logError);
    }
    if (metrics.outcome === "error")
      reportShadowError("measure_failed", metrics.reason, deps.logError);
    return metrics;
  };

  try {
    if (random() * 100 >= shadowSamplePercent(env)) return null;

    // KVKK: kisisel/ozel nitelikli veri, kimlik/sir benzeri ifade Jina'ya GITMEZ (0062 ile ayni suzgec).
    const ineligible = queryContentIneligibility(normalizeQueryText(input.semanticText));
    if (ineligible !== null)
      return save(emptyMetrics("ineligible", model, textCount, topN, ineligible));

    // Aktif indeks (karar 0181): TS'nin sorgu vektoru uretemedigi modelse olcum yapilmaz.
    const resolved = await (deps.resolveIndex ?? ((d) => resolveSemanticIndex(d, { env })))(db);
    if (resolved.index === null) {
      model = resolved.modelVersion;
      return save(emptyMetrics("no_vector", model, textCount, topN, resolved.reason));
    }
    const index = resolved.index;
    model = index.modelVersion;

    const embedder = deps.embedder === undefined ? defaultEmbedder(db, env, index) : deps.embedder;
    if (!embedder) return save(emptyMetrics("no_vector", model, textCount, topN, "no_api_key"));

    const usedToday = await (deps.usedToday ?? defaultUsedToday)(db);
    if (usedToday >= shadowDailyCap(env))
      return save(emptyMetrics("capped", model, textCount, topN));

    const embedStarted = clock();
    const embedded = await embedder.embedQuery(input.semanticText);
    const embedMs = clock() - embedStarted;
    if (!embedded) {
      return save({ ...emptyMetrics("no_vector", model, textCount, topN, "provider"), embedMs });
    }

    const knnStarted = clock();
    const candidates = await (deps.findCandidates ?? findSemanticCandidates)(db, {
      vector: embedded.vector,
      modelVersion: embedder.modelVersion,
      index,
      text: input.queryText,
      filters: input.filters,
    });
    const knnMs = clock() - knnStarted;
    const textSimilarity = await (deps.findSimilarities ?? similaritiesFor)(db, {
      vector: embedded.vector,
      modelVersion: embedder.modelVersion,
      index,
      productIds: input.textItems.map((item) => item.productId),
    });

    return save({
      outcome: "measured",
      reason: null,
      modelVersion: embedder.modelVersion,
      textCount,
      topN,
      textWithVector: textSimilarity.size,
      candidateCount: candidates.length,
      bestSimilarity: candidates[0]?.similarity ?? null,
      ...compareTopN(input.textItems, candidates, input.queryText, textSimilarity, topN),
      embedMs,
      knnMs,
      cacheHit: embedded.cacheHit,
    });
  } catch (error) {
    // Yalniz hata sinifi (mesaj sorgu metnini tasiyabilir).
    const reason =
      (error as { cause?: { code?: string } } | null)?.cause?.code === "57014"
        ? "timeout"
        : error instanceof Error
          ? error.name.toLowerCase().slice(0, 40)
          : "unknown";
    return save(emptyMetrics("error", model, textCount, topN, reason.replace(/[^a-z0-9_]/g, "_")));
  }
}

let inFlight = 0;

/**
 * Arka planda olcer; cagirani BEKLETMEZ ve asla firlatmaz. Mod kapaliysa hicbir sey yapmaz.
 * Ayni anda en fazla `SHADOW_MAX_IN_FLIGHT` olcum: fazlasi sessizce atlanir (havuz aramaya kalir).
 */
export function scheduleSemanticShadow(
  db: Database,
  input: ShadowInput,
  deps: ShadowDeps = {},
): Promise<ShadowMetrics | null> | null {
  if (semanticSearchMode(deps.env ?? process.env) !== "shadow") return null;
  if (input.semanticText.trim() === "") return null;
  if (inFlight >= SHADOW_MAX_IN_FLIGHT) return null;
  inFlight += 1;
  const task = measureSemanticShadow(db, input, deps)
    .catch((error: unknown) => {
      // `measureSemanticShadow` firlatmaz; firlatirsa (programlama hatasi) gorunur olsun.
      reportShadowError("unexpected", error, deps.logError);
      return null;
    })
    .finally(() => {
      inFlight -= 1;
    });
  return task;
}
