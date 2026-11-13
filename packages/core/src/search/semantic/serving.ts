/**
 * Anlamsal SUNUM (karar 0190): `SEMANTIC_SEARCH_MODE=on` iken anlamsal adaylar metin sonucuyla
 * siralamaya karisir. `/ara` ve `/sohbet` AYNI fonksiyonu cagirir.
 *
 * Sozlesme:
 * - Metin sonucu HIC dusmez ve sirasi yalniz RRF fuzyonuyla degisir; en fazla
 *   `SEMANTIC_SERVING_MAX_ADDED` yalniz-anlamsal urun eklenir. Ilk sayfa disinda calismaz.
 * - Her kosul ayri denetlenir: mod, sorgu uygunlugu (KVKK suzgeci), aktif indeks ve modelin TS'de
 *   sorgulanabilirligi, saglayici sagligi (anahtar TANIMLI olmasi yetmez), envanterde HAZIR ve
 *   model/boyut/surum uyumlu indeks, gunluk tavan. Biri tutmazsa sonuc metin aramasinin AYNISIDIR.
 * - Strateji secicisi (karar 0189) yalniz `global_hnsw` ya da `exact_btree` dondururse calisir.
 *   `legacy_postfilter` (HNSW'siz tam tarama) istek yolunda HIC calistirilmaz: buyuk tabloda
 *   kontrolsuz tarama olurdu ve kategori filtresinde eksik sonuc verir (E3-d.1).
 * - Her hata yakalanir; sonuc metin aramasidir. Gunluge yalniz yapisal alanlar yazilir: sorgu
 *   metni, urun kimligi, anahtar YOK.
 * - Ucretli cagri yalniz yukaridaki kosullar tuttuktan sonra yapilir ve `api_usage`a yazilir
 *   (kural 9). 401/402/403 devreyi uzun sure acar; otomatik bakiye yukleme yoktur.
 */
import { apiUsage, type Database } from "@arilla/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { costMicrosPerThousandTokens } from "../../embedding/embed-uploaded-image.ts";
import { selectorCategory } from "../category-source.ts";
import type { RankedSearchItem, SearchOutcomeMode } from "../fallback/types.ts";
import { queryContentIneligibility } from "../interpretation-eligibility.ts";
import { normalizeQueryText } from "../normalize.ts";
import { cardsForProducts } from "../search.ts";
import type { QueryFilters, SortMode } from "../types.ts";
import { type IndexResolution, resolveSemanticIndex, type SemanticIndex } from "./active-index.ts";
import {
  SEMANTIC_SERVING_KNN_LIMIT,
  SEMANTIC_SERVING_MAX_ADDED,
  SEMANTIC_SERVING_SQL_TIMEOUT_MS,
  SEMANTIC_STATS_TIMEOUT_MS,
  semanticIndexVersion,
  semanticSearchMode,
  servingDailyCap,
} from "./config.ts";
import { loadCategoryStat, loadSemanticInventory } from "./inventory.ts";
import { type ProviderHealth, providerHealthFor } from "./provider-health.ts";
import { createJinaQueryEmbedder, type QueryEmbedder } from "./query-embedder.ts";
import {
  findCategoryExactCandidates,
  findSemanticCandidates,
  type SemanticCandidate,
  similaritiesFor,
} from "./semantic-candidates.ts";
import { fuseForQuery, SEMANTIC_QUERY_OPERATION } from "./shadow.ts";
import {
  type CategoryStat,
  DEFAULT_STRATEGY_CONFIG,
  type IndexDescriptor,
  type StrategyDecision,
  selectSemanticStrategy,
} from "./strategy.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type ServingOutcome = "disabled" | "skipped" | "served" | "error";

export interface ServingTelemetry {
  outcome: ServingOutcome;
  /** Neden (sabit kucuk sozluk; serbest metin yok). */
  reason: string;
  strategy: StrategyDecision["strategy"] | null;
  categoryMode: StrategyDecision["categoryMode"] | null;
  candidateCount: number;
  added: number;
  embedMs: number | null;
  knnMs: number | null;
}

export interface ServingInput<T extends RankedSearchItem> {
  /** Anlamsal olarak embed edilecek metin. */
  semanticText: string;
  /** Baslik korumalari icin tam sorgu metni. */
  queryText: string;
  filters: QueryFilters;
  items: readonly T[];
  mode: SearchOutcomeMode;
  page: number;
  /** Yalniz `balanced`: fiyat sekmesinin sirasi fuzyonla bozulmaz. */
  sort: SortMode;
}

export interface ServingDeps {
  env?: Env;
  embedder?: QueryEmbedder | null;
  health?: ProviderHealth;
  resolveIndex?: (db: Database) => Promise<IndexResolution>;
  loadInventory?: (db: Database, index: SemanticIndex) => Promise<IndexDescriptor[] | null>;
  loadStat?: (
    db: Database,
    index: SemanticIndex,
    modelVersion: string,
    path: string,
  ) => Promise<CategoryStat | null>;
  findGlobal?: typeof findSemanticCandidates;
  findExact?: typeof findCategoryExactCandidates;
  findSimilarities?: typeof similaritiesFor;
  hydrate?: (
    db: Database,
    ids: readonly number[],
    filters: QueryFilters,
  ) => Promise<RankedSearchItem[]>;
  usedToday?: (db: Database) => Promise<number>;
  log?: (event: ServingTelemetry) => void;
  clock?: () => number;
  now?: () => Date;
}

function telemetry(
  outcome: ServingOutcome,
  reason: string,
  extra: Partial<ServingTelemetry> = {},
): ServingTelemetry {
  return {
    outcome,
    reason,
    strategy: null,
    categoryMode: null,
    candidateCount: 0,
    added: 0,
    embedMs: null,
    knnMs: null,
    ...extra,
  };
}

/** Yapisal gunluk satiri: yalniz sabit alanlar ve sayilar (kisisel veri/sir yok). */
export function logServing(event: ServingTelemetry): void {
  if (event.outcome === "disabled") return;
  const line = JSON.stringify({ event: "semantic_serving", ...event });
  if (event.outcome === "error") console.warn(line);
  else console.info(line);
}

/** Surec ici sayaclar (outcome:reason -> adet); yonetim/teshis icin, kisisel veri yok. */
const counters = new Map<string, number>();

export function semanticServingCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetSemanticServingCounters(): void {
  counters.clear();
}

function errorReason(error: unknown): string {
  const code =
    (error as { cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  if (code === "57014") return "timeout";
  const name = error instanceof Error ? error.name : "unknown";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 40);
}

function defaultEmbedder(
  db: Database,
  env: Env,
  index: SemanticIndex,
  health: ProviderHealth,
): QueryEmbedder | null {
  const apiKey = env.JINA_API_KEY?.trim();
  if (!apiKey) return null;
  return createJinaQueryEmbedder(apiKey, index.modelVersion, {
    dimensions: index.dimensions,
    task: index.queryTask,
    onFailure: (failure) => health.failure(failure),
    onSuccess: () => health.success(),
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

async function defaultHydrate(
  db: Database,
  ids: readonly number[],
  filters: QueryFilters,
): Promise<RankedSearchItem[]> {
  const cards = await cardsForProducts(db, ids, filters);
  return cards.map((card) => ({
    ...card,
    match: { tier: "related", score: 0, stage: "related", relaxed: [], missing: [] },
  }));
}

/**
 * Sunum. Asla firlatmaz. `items` yalniz `outcome === "served"` iken degisir; aksi her durumda
 * girdi dizisinin kendisi doner.
 */
export async function applySemanticServing<T extends RankedSearchItem>(
  db: Database,
  input: ServingInput<T>,
  deps: ServingDeps = {},
): Promise<{ items: readonly (T | RankedSearchItem)[]; telemetry: ServingTelemetry }> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? logServing;
  const clock = deps.clock ?? (() => performance.now());
  const done = (t: ServingTelemetry, items: readonly (T | RankedSearchItem)[] = input.items) => {
    const key = `${t.outcome}:${t.reason}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
    try {
      log(t);
    } catch {
      // Gunluk yazilamazsa arama etkilenmez.
    }
    return { items, telemetry: t };
  };

  if (semanticSearchMode(env) !== "on")
    return { items: input.items, telemetry: telemetry("disabled", "mode") };

  let decision: StrategyDecision | null = null;
  try {
    if (input.page !== 1) return done(telemetry("skipped", "not_first_page"));
    if (input.sort !== "balanced") return done(telemetry("skipped", "sort_not_balanced"));
    if (input.mode === "empty") return done(telemetry("skipped", "lexical_empty"));
    if (input.semanticText.trim() === "") return done(telemetry("skipped", "empty_text"));
    if (queryContentIneligibility(normalizeQueryText(input.semanticText)) !== null) {
      return done(telemetry("skipped", "ineligible"));
    }

    const resolved = await (deps.resolveIndex ?? ((d) => resolveSemanticIndex(d, { env })))(db);
    if (resolved.index === null) return done(telemetry("skipped", resolved.reason));
    const index = resolved.index;
    const health = deps.health ?? providerHealthFor(index.modelVersion);

    // Envanter ve secim: ucretli cagridan ONCE (indeks yoksa saglayiciya hic gidilmez).
    const inventory = await (deps.loadInventory ?? loadSemanticInventory)(db, index);
    const category = selectorCategory(input.filters);
    let stats: Map<string, CategoryStat> | null = null;
    if (category?.source === "explicit") {
      const stat = await (
        deps.loadStat ??
        ((d, i, m, p) =>
          loadCategoryStat(d, {
            index: i,
            modelVersion: m,
            path: p,
            cap: DEFAULT_STRATEGY_CONFIG.exactMaxRows,
            timeoutMs: SEMANTIC_STATS_TIMEOUT_MS,
          }))
      )(db, index, index.modelVersion, category.path);
      stats = stat ? new Map([[category.path, stat]]) : null;
    }
    decision = selectSemanticStrategy({
      modelVersion: index.modelVersion,
      indexVersion: semanticIndexVersion(env),
      category,
      hasPriceFilter: input.filters.price_min != null || input.filters.price_max != null,
      inventory,
      categoryStats: stats,
      now: (deps.now ?? (() => new Date()))(),
    });
    const base = { strategy: decision.strategy, categoryMode: decision.categoryMode };
    if (decision.strategy !== "global_hnsw" && decision.strategy !== "exact_btree") {
      return done(telemetry("skipped", `strategy_${decision.strategy}`, base));
    }

    if (!health.allow()) return done(telemetry("skipped", "provider_unhealthy", base));
    const embedder =
      deps.embedder === undefined ? defaultEmbedder(db, env, index, health) : deps.embedder;
    if (!embedder) return done(telemetry("skipped", "no_api_key", base));
    if ((await (deps.usedToday ?? defaultUsedToday)(db)) >= servingDailyCap(env)) {
      return done(telemetry("skipped", "capped", base));
    }

    const embedStarted = clock();
    const embedded = await embedder.embedQuery(input.semanticText);
    const embedMs = clock() - embedStarted;
    if (!embedded) return done(telemetry("skipped", "no_vector", { ...base, embedMs }));

    const knnStarted = clock();
    const request = {
      vector: embedded.vector,
      modelVersion: index.modelVersion,
      index,
      text: input.queryText,
      filters: input.filters,
      statementTimeoutMs: SEMANTIC_SERVING_SQL_TIMEOUT_MS,
    };
    let candidates: SemanticCandidate[];
    if (decision.strategy === "exact_btree") {
      candidates = await (deps.findExact ?? findCategoryExactCandidates)(db, {
        ...request,
        categoryPath: decision.categoryPath as string,
        maxRows: DEFAULT_STRATEGY_CONFIG.exactMaxRows,
      });
    } else {
      // Secicinin ef_search'u (150) ayni zamanda KNN penceresidir: 102k satirda yerel olcum
      // k150/ef150 p95 ~14 ms, k400/ef400 p95 ~26 ms (karar 0190 "Olcum").
      const window = decision.efSearch ?? SEMANTIC_SERVING_KNN_LIMIT;
      candidates = await (deps.findGlobal ?? findSemanticCandidates)(db, {
        ...request,
        knnLimit: window,
        efSearch: window,
      });
    }
    const textSimilarity = await (deps.findSimilarities ?? similaritiesFor)(db, {
      vector: embedded.vector,
      modelVersion: index.modelVersion,
      index,
      productIds: input.items.map((item) => item.productId),
    });
    const knnMs = clock() - knnStarted;

    const { fused } = fuseForQuery(input.items, candidates, input.queryText, textSimilarity);
    const semanticOnly = fused
      .filter((entry) => entry.source === "semantic")
      .slice(0, SEMANTIC_SERVING_MAX_ADDED)
      .map((entry) => entry.item.productId);
    const cards = await (deps.hydrate ?? defaultHydrate)(db, semanticOnly, input.filters);
    const cardById = new Map(cards.map((card) => [card.productId, card]));
    const textById = new Map(input.items.map((item) => [item.productId, item]));
    const out: (T | RankedSearchItem)[] = [];
    for (const entry of fused) {
      const text = textById.get(entry.item.productId);
      if (text) {
        out.push(text);
        continue;
      }
      const card = cardById.get(entry.item.productId);
      if (card) out.push({ ...card, match: { ...card.match, score: entry.similarity ?? 0 } });
    }
    // Savunma: metin sonucu dusmus olamaz (fuzyon tur uyumsuzlugunu cikarabilir; o zaman ekle).
    for (const item of input.items) if (!out.includes(item)) out.push(item);
    const added = out.length - input.items.length;
    return done(
      telemetry("served", added > 0 ? "fused" : "no_new_candidates", {
        ...base,
        candidateCount: candidates.length,
        added,
        embedMs,
        knnMs,
      }),
      out,
    );
  } catch (error) {
    return done(
      telemetry("error", errorReason(error), {
        strategy: decision?.strategy ?? null,
        categoryMode: decision?.categoryMode ?? null,
      }),
    );
  }
}
