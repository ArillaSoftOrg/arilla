/**
 * `searchWithFallback`: yapay zekasiz, asamali arama orkestrasyonu.
 *
 *   QueryObject (mevcut ayristirici) -> SearchQuery -> SearchProvider -> siralanmis sonuc
 *
 * Istek yolunda model cagrisi YOK (CLAUDE.md kural 1): bu klasorde LLM/istemci
 * importu bulunmaz, `no-llm.test.ts` bunu kaynak duzeyinde dogrular.
 *
 * Akis:
 * 1. `exact`: mevcut davranis. Sonuc varsa ve model kodu celismiyorsa aynen
 *    doner (siralama ve sayfalama saglayicinindir, regresyon yok).
 * 2. Sonuc yok ya da hepsi model kodu celiskili: `planFallbackStages` adimlari
 *    sirayla denenir. Her aday `gradeItem` ile dogrulanir; GERCEK eslesme
 *    (`exact`) cikarsa dongu durur ve normal sonuc olarak doner.
 * 3. Gercek eslesme yoksa yakin adaylar (`close`/`related`) esikten gecerse
 *    `fallback`, gecmezse `empty`. Alakasiz urun gostermektense hicbir sey.
 */

import { textSlotsOf } from "../search-sql.ts";
import type { QueryObject, SortMode } from "../types.ts";
import { type AliasSource, NO_ALIASES } from "./aliases.ts";
import { analyzeQuery, type QueryToken } from "./analyze.ts";
import { canonicalKey, gradeItem, MIN_RELATED_SCORE } from "./grade.ts";
import { planFallbackStages } from "./stages.ts";
import type {
  FallbackReason,
  FallbackSearchOutcome,
  MatchTier,
  RankedSearchItem,
  Relaxation,
  SearchProvider,
  SearchQuery,
  SearchStageId,
  SearchTrace,
} from "./types.ts";

/** Fallback'te gosterilen en fazla yakin sonuc (docs/pages.md: "en yakin 6" -> bir sira daha). */
export const FALLBACK_RESULT_LIMIT = 12;
/** Gevsetilmis adimlarda saglayicidan istenen aday sayisi. */
const CANDIDATE_LIMIT = 48;
/** Model kodu dogrulamasi gereken sorguda ilk adimda bellege alinan pencere. */
const VERIFY_WINDOW = 96;

/**
 * Fallback adimlari icin sure butcesi. Her adim bir DB turudur; katalog buyudukce
 * (ve terim sik gecen bir kelimeyse) tek tur saniyeler surebilir. Butce dolunca
 * kalan adimlar denenmez, eldeki adaylarla yanit verilir.
 */
export const FALLBACK_TIME_BUDGET_MS = 1500;

/** Kisit gevsetmenin puan bedeli ve en iyi katman tavani. */
const CONSTRAINT_PENALTY: Partial<Record<Relaxation, number>> = {
  color: 0.1,
  size: 0.1,
  category: 0.2,
};

export interface FallbackSearchRequest {
  /** Mevcut ayristirici/konusma planinin urettigi sorgu nesnesi. */
  parsed: QueryObject;
  sort: SortMode;
  page: number;
  pageSize: number;
}

export interface FallbackSearchOptions {
  /** Takma ad kaynagi; varsayilan: yok. */
  aliases?: AliasSource;
  /** Gozlem: sonuc hazir olunca bir kez cagrilir. Hata aramayi bozmaz. */
  onTrace?: (trace: SearchTrace) => void;
  /** Test icin; varsayilan `performance.now`. */
  clock?: () => number;
  /** Fallback adimlari icin toplam sure butcesi (ms); varsayilan `FALLBACK_TIME_BUDGET_MS`. */
  timeBudgetMs?: number;
}

const TIER_RANK: Record<MatchTier, number> = { exact: 0, close: 1, related: 2 };

/** Kisit gevsetmesinin izin verdigi en iyi katman. */
function capTier(tier: MatchTier, relaxed: readonly Relaxation[]): MatchTier {
  let cap: MatchTier = "exact";
  if (relaxed.includes("color") || relaxed.includes("size")) cap = "close";
  if (relaxed.includes("category")) cap = "related";
  return TIER_RANK[tier] >= TIER_RANK[cap] ? tier : cap;
}

function constraintPenalty(relaxed: readonly Relaxation[]): number {
  return relaxed.reduce((sum, key) => sum + (CONSTRAINT_PENALTY[key] ?? 0), 0);
}

function toSearchQuery(
  parsed: QueryObject,
  sort: SortMode,
  limit: number,
  offset: number,
): SearchQuery {
  return {
    text: parsed.text,
    slots: textSlotsOf(parsed),
    filters: parsed.filters,
    sort,
    limit,
    offset,
    fuzzy: false,
  };
}

interface PoolEntry {
  item: RankedSearchItem;
  order: number;
}

function compareEntries(a: PoolEntry, b: PoolEntry): number {
  const tier = TIER_RANK[a.item.match.tier] - TIER_RANK[b.item.match.tier];
  if (tier !== 0) return tier;
  // 0.05'lik kovalar: ayni alaka duzeyinde saglayicinin (guven/fiyat/stok) sirasi korunur.
  const bucket = Math.round(b.item.match.score * 20) - Math.round(a.item.match.score * 20);
  if (bucket !== 0) return bucket;
  return a.order - b.order;
}

export async function searchWithFallback(
  provider: SearchProvider,
  request: FallbackSearchRequest,
  options: FallbackSearchOptions = {},
): Promise<FallbackSearchOutcome> {
  const clock = options.clock ?? (() => performance.now());
  const startedAt = clock();
  const { parsed, sort, page, pageSize } = request;
  const offset = (page - 1) * pageSize;

  const analysis = analyzeQuery(parsed, options.aliases ?? NO_ALIASES);
  const stagesTried: SearchStageId[] = [];
  let truncated = false;
  const budget = options.timeBudgetMs ?? FALLBACK_TIME_BUDGET_MS;

  const finish = (
    mode: FallbackSearchOutcome["mode"],
    items: RankedSearchItem[],
    total: number,
    stage: SearchStageId,
    reason: FallbackReason | null,
  ): FallbackSearchOutcome => {
    const trace: SearchTrace = {
      queryNorm: analysis.normalized || parsed.text.trim().toLowerCase(),
      provider: provider.name,
      stage,
      stagesTried,
      mode,
      resultCount: mode === "results" ? total : items.length,
      fallbackReason: reason,
      relaxed: items[0]?.match.relaxed ?? [],
      latencyMs: Math.round(clock() - startedAt),
      truncated,
    };
    try {
      options.onTrace?.(trace);
    } catch {
      // Gozlem aramayi asla bozmaz.
    }
    return { mode, items, total, sort, trace };
  };

  const asExact = (items: SearchQueryItems, stage: SearchStageId, relaxed: Relaxation[] = []) =>
    items.map<RankedSearchItem>((item) => ({
      ...item,
      match: { tier: "exact", score: 1, stage, relaxed, missing: [] },
    }));

  // ---- 1. exact: mevcut davranis -------------------------------------------------
  const verify = analysis.tokens.some((token) => token.kind === "model");
  stagesTried.push("exact");
  const first = await provider.search(
    verify
      ? toSearchQuery(parsed, sort, VERIFY_WINDOW, 0)
      : toSearchQuery(parsed, sort, pageSize, offset),
  );

  if (!verify && first.items.length > 0) {
    return finish("results", asExact(first.items, "exact"), first.total, "exact", null);
  }
  // Sayfa sinirinin otesi: "sonuc yok" degil, fallback gostermeyiz.
  if (offset > 0 && first.items.length === 0) {
    return finish("empty", [], 0, "exact", "no_candidates");
  }

  const pool = new Map<number, PoolEntry>();
  const keys = new Map<string, number>();
  let order = 0;

  const consider = (
    item: SearchQueryItems[number],
    stage: SearchStageId,
    relaxed: Relaxation[],
    stageTokens: readonly QueryToken[] = analysis.tokens,
  ): void => {
    const grade = gradeItem(analysis.tokens, item);
    let graded = grade.tier;
    const gradedScore = grade.score;
    let floored = false;
    if (graded === "none" && stageTokens !== analysis.tokens) {
      // Gevsetilmis adimin tum tokenlarini tasiyan urun (ayni aile / ayni bas isim)
      // sorgunun ilgili urunudur; esik tabaninda kalir, yakinlardan sonra gelir.
      if (gradeItem(stageTokens, item).tier === "exact") {
        graded = "related";
        floored = true;
      }
    }
    if (graded === "none") return;
    const tier = capTier(graded, relaxed);
    const penalized = Math.max(0, gradedScore - constraintPenalty(relaxed));
    const score = floored ? Math.max(MIN_RELATED_SCORE, penalized) : penalized;
    if (tier !== "exact" && score < MIN_RELATED_SCORE) return;
    const entry: PoolEntry = {
      order: order++,
      item: {
        ...item,
        match: { tier, score, stage, relaxed, missing: grade.missing },
      },
    };
    const key = canonicalKey(item);
    const existingId = keys.get(key);
    const existing = existingId === undefined ? undefined : pool.get(existingId);
    const duplicate = pool.get(item.productId) ?? existing;
    if (duplicate) {
      if (compareEntries(entry, duplicate) >= 0) return;
      pool.delete(duplicate.item.productId);
    }
    pool.set(item.productId, entry);
    keys.set(key, item.productId);
  };

  const exactEntries = (): PoolEntry[] =>
    [...pool.values()].filter((entry) => entry.item.match.tier === "exact").sort(compareEntries);

  // Model dogrulamasi: model kodu tutan sonuclar normal sonuc, tutmayanlar aday.
  if (verify) {
    for (const item of first.items) consider(item, "exact", []);
    const exact = exactEntries();
    if (exact.length > 0) {
      const items = exact.map((entry) => entry.item);
      return finish("results", items.slice(offset, offset + pageSize), items.length, "exact", null);
    }
  }

  // ---- 2. fallback adimlari (yalnizca ilk sayfa) ------------------------------
  if (offset > 0) return finish("empty", [], 0, "exact", "no_candidates");

  const baseSlots = toSearchQuery(parsed, sort, 0, 0).slots;
  const baseWords = new Set(baseSlots.flat());
  const hasAliasExpansion = analysis.tokens.some((token) =>
    token.alternatives.some((alternative) => !baseWords.has(alternative)),
  );
  const stages = planFallbackStages({
    text: parsed.text,
    tokens: analysis.tokens,
    baseSlots,
    filters: parsed.filters,
    sort,
    hasAliasExpansion,
    // Yazim hatasi yalnizca exact adim HIC aday getirmediyse suphelidir; aday geldiyse
    // (ama model kodu celiskiliyse) bulanik adim gereksiz bir DB turudur.
    canFuzzy:
      first.items.length === 0 &&
      analysis.tokens.some((token) => token.kind === "word" && token.value.length >= 4),
    limit: CANDIDATE_LIMIT,
  });

  let lastStage: SearchStageId = "exact";
  for (const stage of stages) {
    if (clock() - startedAt > budget) {
      truncated = true;
      break;
    }
    stagesTried.push(stage.id);
    lastStage = stage.id;
    const page = await provider.search(stage.query);
    for (const item of page.items) consider(item, stage.id, stage.relaxed, stage.tokens);

    const exact = exactEntries();
    if (exact.length > 0) {
      // Gevsetme olmadan tum tokenlar tutan urun: gercek eslesme (typo/takma ad dahil).
      const items = exact.map((entry) => entry.item);
      return finish(
        "results",
        items.slice(offset, offset + pageSize),
        items.length,
        stage.id,
        null,
      );
    }
    const enough = [...pool.values()].filter((entry) => entry.item.match.tier === "close");
    if (enough.length >= FALLBACK_RESULT_LIMIT) break;
  }

  // ---- 3. yakin sonuclar -----------------------------------------------------
  const ranked = [...pool.values()].sort(compareEntries).slice(0, FALLBACK_RESULT_LIMIT);
  if (ranked.length === 0) {
    return finish("empty", [], 0, lastStage, "no_candidates");
  }
  const best = ranked[0] as PoolEntry;
  return finish(
    "fallback",
    ranked.map((entry) => entry.item),
    ranked.length,
    best.item.match.stage,
    "no_exact_match",
  );
}

type SearchQueryItems = Awaited<ReturnType<SearchProvider["search"]>>["items"];
