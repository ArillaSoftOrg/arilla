/**
 * `/yonetim/arama/tani` (Faz 4): bir sorgunun `/ara`'da nasıl işlendiğini
 * adım adım gösterir. GERÇEK boru hattını kullanır — `normalizeQueryText`,
 * `loadLexicon`, `parseQueryText`, `planConversation`, `search()` — kopya
 * bir sıralama yazılmaz, yoksa tanı gerçeği göstermez.
 *
 * Yan etki YOK:
 * - `resolveQuery` ÇAĞRILMAZ: o `query_resolution`'a yazar (önbellek + sayaç).
 *   Önbellek yalnızca okunur; taze ayrıştırma ile karşılaştırılır.
 * - Arama duvarı sayacı, analitik olay, `api_usage` yazılmaz.
 * - Tüm sorgular `READ ONLY` işlemde ve zaman aşımlı çalışır; araya yazan bir
 *   fonksiyon girerse motor reddeder.
 */
import { type Database, queryResolution } from "@arilla/db";
import { eq } from "drizzle-orm";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { planConversation } from "../conversational-search/plan.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";
import { findLexiconMatches } from "../search/lexicon.ts";
import { loadLexicon } from "../search/lexicon-repository.ts";
import { normalizeQueryText } from "../search/normalize.ts";
import { parseQueryText } from "../search/parse-query.ts";
import { search } from "../search/search.ts";
import type { QueryObject, SortMode } from "../search/types.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const DIAGNOSTIC_QUERY_MAX = 200;
const RESULT_LIMIT = 20;
const FALLBACK_LIMIT = 6;

export class SearchDiagnosticsInputError extends Error {
  constructor() {
    super(`Sorgu 1–${DIAGNOSTIC_QUERY_MAX} karakter olmalı.`);
    this.name = "SearchDiagnosticsInputError";
  }
}

/** Yönetici başına dakikada en fazla bu kadar tanı çalıştırılır (gerçek arama sorgusu). */
export const DIAGNOSTICS_PER_MINUTE = 30;

/**
 * Tanı kotası. Aşılırsa `false`. Redis yoksa `true` (açık kalır): ekran
 * yalnızca personele açık ve arama zaten zaman aşımlı; kota kolaylık
 * sınırıdır, güvenlik sınırı değil.
 */
export async function consumeDiagnosticsQuota(actor: AdminActor): Promise<boolean> {
  assertCapability(actor, "diagnostics.read");
  try {
    const count = await incrementFixedWindow(`admin:diag:${actor.userId}`, 60);
    return count <= DIAGNOSTICS_PER_MINUTE;
  } catch (error) {
    if (isRedisUnavailableError(error)) return true;
    throw error;
  }
}

export interface DiagnosticResultItem {
  rank: number;
  productId: number;
  slug: string;
  title: string;
  brandName: string | null;
  categoryPath: string | null;
  minPrice: number | null;
  inStock: boolean | null;
  offerCount: number;
  merchantTrustScore: number | null;
  currentPercentile: number | null;
  score: number;
}

export interface SearchDiagnostics {
  input: string;
  queryNorm: string;
  cache: {
    present: boolean;
    parserTier: number | null;
    hitCount: number | null;
    lastUsedAt: Date | null;
    /** Önbellekteki ayrıştırma bugünkü sözlükle üretilenden farklı mı (bayat önbellek). */
    differsFromFresh: boolean | null;
  };
  lexiconMatches: { kind: string; surface: string; normalized: string; weight: number }[];
  freshParse: QueryObject;
  plan: {
    mode: "conventional" | "conversation";
    action: "clarify" | "search" | null;
    question: string | null;
    constraints: string[];
  };
  /** `/ara`'nın `search()`'e verdiği sorgu. */
  effectiveQuery: QueryObject;
  effectiveSource: "conversation" | "cache" | "fresh";
  sort: SortMode;
  total: number;
  results: DiagnosticResultItem[];
  /** Sonuç yoksa `/ara`'nın gösterdiği filtresiz yedek. */
  fallback: DiagnosticResultItem[] | null;
  elapsedMs: number;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export async function explainSearch(
  db: Database,
  actor: AdminActor,
  rawText: string,
  sort: SortMode = "balanced",
): Promise<SearchDiagnostics> {
  assertCapability(actor, "diagnostics.read");
  const input = typeof rawText === "string" ? rawText.trim() : "";
  if (input.length === 0 || input.length > DIAGNOSTIC_QUERY_MAX) {
    throw new SearchDiagnosticsInputError();
  }
  // Metin aramasında `closest_match` yok (anchor yok) — /ara ile aynı indirgeme.
  const effectiveSort: SortMode = sort === "best_deal" ? "best_deal" : "balanced";
  const started = Date.now();

  return readOnly(db, 8_000, async (tx) => {
    // İşlem nesnesi `Database` ile aynı sorgu yüzeyine sahip; gerçek boru
    // hattı fonksiyonları değiştirilmeden READ ONLY işlem içinde çalışır.
    const rdb = tx as unknown as Database;
    const queryNorm = normalizeQueryText(input);

    const cachedRows = await tx
      .select()
      .from(queryResolution)
      .where(eq(queryResolution.queryNorm, queryNorm))
      .limit(1);
    const cached = cachedRows[0];

    const lexicon = await loadLexicon(rdb);
    const freshParse = parseQueryText(input, lexicon);
    const plan = planConversation(
      { query: input, steps: [], reply: null },
      { registry: DEFAULT_CLARIFICATION_REGISTRY, lexicon },
    );

    let effectiveQuery: QueryObject;
    let effectiveSource: SearchDiagnostics["effectiveSource"];
    if (plan.mode === "conversation") {
      effectiveQuery = plan.queryObject;
      effectiveSource = "conversation";
    } else if (cached) {
      effectiveQuery = cached.parsed as QueryObject;
      effectiveSource = "cache";
    } else {
      effectiveQuery = freshParse;
      effectiveSource = "fresh";
    }

    const toItems = (items: Awaited<ReturnType<typeof search>>["items"]): DiagnosticResultItem[] =>
      items.map((item, index) => ({
        rank: index + 1,
        productId: item.productId,
        slug: item.slug,
        title: item.title,
        brandName: item.brandName,
        categoryPath: item.categoryPath,
        minPrice: item.minPrice,
        inStock: item.inStock,
        offerCount: item.offerCount,
        merchantTrustScore: item.merchantTrustScore,
        currentPercentile: item.currentPercentile,
        score: item.score,
      }));

    const result = await search(
      rdb,
      { ...effectiveQuery, sort: effectiveSort },
      { limit: RESULT_LIMIT, offset: 0 },
    );
    const fallback =
      result.items.length === 0
        ? toItems(
            (
              await search(
                rdb,
                { ...effectiveQuery, filters: {}, sort: "balanced" },
                { limit: FALLBACK_LIMIT },
              )
            ).items,
          )
        : null;

    const normalized = normalizeQueryText(input);
    return {
      input,
      queryNorm,
      cache: {
        present: Boolean(cached),
        parserTier: cached?.parserTier ?? null,
        hitCount: cached?.hitCount ?? null,
        lastUsedAt: cached?.lastUsedAt ?? null,
        differsFromFresh: cached ? stable(cached.parsed) !== stable(freshParse) : null,
      },
      lexiconMatches: findLexiconMatches(normalized, lexicon)
        .slice(0, 50)
        .map(({ entry }) => ({
          kind: entry.kind,
          surface: entry.surface,
          normalized: entry.normalized,
          weight: entry.weight,
        })),
      freshParse,
      plan: {
        mode: plan.mode,
        action: plan.mode === "conversation" ? plan.action : null,
        question: plan.mode === "conversation" ? (plan.question?.text ?? null) : null,
        constraints: plan.mode === "conversation" ? plan.constraints.map((chip) => chip.label) : [],
      },
      effectiveQuery,
      effectiveSource,
      sort: effectiveSort,
      total: result.total,
      results: toItems(result.items),
      fallback,
      elapsedMs: Date.now() - started,
    };
  });
}
