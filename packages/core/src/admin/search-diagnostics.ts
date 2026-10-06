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
import { eq, sql } from "drizzle-orm";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import {
  type InterpretationSource,
  planConversationWithInterpretationSource,
} from "../conversational-search/stored-plan.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";
import { findLexiconMatches } from "../search/lexicon.ts";
import { loadLexicon } from "../search/lexicon-repository.ts";
import { normalizeQueryText } from "../search/normalize.ts";
import { parseQueryText } from "../search/parse-query.ts";
import { isStaleResolution } from "../search/query-resolution.ts";
import { search } from "../search/search.ts";
import {
  type CandidateFunnel,
  candidateFunnel,
  type ProductProbe,
  probeProduct,
  rankWithFactors,
  type ScoreFactors,
} from "../search/search-explain.ts";
import { TOKEN_MATCH_THRESHOLD } from "../search/text-match.ts";
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
  /** Skor çarpanları; yedek listede (search() ile) yok. */
  factors: ScoreFactors | null;
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
    /** Ilk turun yorum kaynagi: kural sozlugu, saklanan model yorumu ya da hicbiri. */
    interpretationSource: InterpretationSource;
  };
  /** `/ara`'nın `search()`'e verdiği sorgu. */
  effectiveQuery: QueryObject;
  effectiveSource: "conversation" | "cache" | "fresh";
  sort: SortMode;
  /** Aday kapıları: her adımda kaç ürün kaldı. */
  funnel: CandidateFunnel;
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

type Rdb = Database;

/**
 * `/ara`'nın `search()`'e verdiği sorguyu yazmadan kurar: konuşma planı
 * netleştirme moduna geçiyorsa onun sorgusu, değilse önbellek (yalnızca
 * okunur), o da yoksa taze ayrıştırma. `resolveQuery` çağrılmaz.
 */
async function resolveEffectiveQuery(rdb: Rdb, input: string, queryNorm: string) {
  const cachedRows = await rdb
    .select()
    .from(queryResolution)
    .where(eq(queryResolution.queryNorm, queryNorm))
    .limit(1);
  const cached = cachedRows[0];

  const lexicon = await loadLexicon(rdb);
  const freshParse = parseQueryText(input, lexicon);
  // `/ara` ile AYNI yol: deterministik domain yoksa saklanan model yorumu okunur
  // (salt okunur; model cagrisi ve yazma yok).
  const { plan, interpretationSource } = await planConversationWithInterpretationSource(
    rdb,
    { query: input, steps: [], reply: null },
    { registry: DEFAULT_CLARIFICATION_REGISTRY, lexicon },
  );

  let effectiveQuery: QueryObject;
  let effectiveSource: SearchDiagnostics["effectiveSource"];
  if (plan.mode === "conversation") {
    effectiveQuery = plan.queryObject;
    effectiveSource = "conversation";
  } else if (cached && !isStaleResolution(cached)) {
    effectiveQuery = cached.parsed as QueryObject;
    effectiveSource = "cache";
  } else {
    effectiveQuery = freshParse;
    effectiveSource = "fresh";
  }

  return {
    cached,
    lexicon,
    freshParse,
    plan,
    interpretationSource,
    effectiveQuery,
    effectiveSource,
  };
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

    const {
      cached,
      lexicon,
      freshParse,
      plan,
      interpretationSource,
      effectiveQuery,
      effectiveSource,
    } = await resolveEffectiveQuery(rdb, input, queryNorm);

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
        factors: null,
      }));

    const textSort = effectiveSort === "best_deal" ? "best_deal" : "balanced";
    const sortedQuery = { ...effectiveQuery, sort: effectiveSort };
    // `/ara` ile aynı CTE + sıra; çarpanlar aynı ifadelerden ayrı kolon.
    const result = await rankWithFactors(rdb, sortedQuery, textSort, RESULT_LIMIT);
    const funnel = await candidateFunnel(rdb, sortedQuery, textSort);
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
        interpretationSource,
      },
      effectiveQuery,
      effectiveSource,
      sort: effectiveSort,
      funnel,
      total: result.total,
      results: result.items,
      fallback,
      elapsedMs: Date.now() - started,
    };
  });
}

export const PRODUCT_REF_MAX = 200;

export class ProductRefInputError extends Error {
  constructor() {
    super("Ürün kimliği (sayı) ya da adres adı (slug) gir.");
    this.name = "ProductRefInputError";
  }
}

/** Kimlik ya da slug; başka biçim reddedilir (allowlist). */
export function parseProductRef(raw: unknown): { id: number } | { slug: string } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (/^\d+$/.test(value)) {
    // Yalnızca rakamsa kimliktir; geçersiz kimlik slug sayılmaz.
    const id = Number(value);
    if (value.length <= 15 && Number.isSafeInteger(id) && id > 0) return { id };
    throw new ProductRefInputError();
  }
  if (value.length > 0 && value.length <= PRODUCT_REF_MAX && /^[\p{Ll}\p{N}-]+$/u.test(value)) {
    return { slug: value };
  }
  throw new ProductRefInputError();
}

export type AbsenceReasonCode =
  | "no_offer"
  | "no_active_offer"
  | "merchant_inactive"
  | "offer_filter"
  | "prefilter"
  | "text_gate"
  | "filter"
  | "no_price_stats"
  | "list_price_inflated"
  | "image_duplicate"
  | "below_limit"
  | "unexplained";

export interface AbsenceReason {
  code: AbsenceReasonCode;
  /** Kanıt cümlesi: yalnızca ölçülen değerlerden kurulur. */
  text: string;
  filter?: string;
}

const FILTER_LABELS: Record<string, string> = {
  category: "kategori",
  color: "renk",
  price_min: "en düşük fiyat",
  price_max: "en yüksek fiyat",
  size: "beden",
  brand_include: "marka",
  brand_exclude: "hariç tutulan marka",
};

/**
 * Ürünün listede olmamasının (ya da alt sırada kalmasının) KANITLANABİLİR
 * nedenleri. Her neden `probeProduct`'ın aynı SQL ifadeleriyle ölçtüğü bir
 * değere dayanır; ölçülmeyen bir neden üretilmez. Hiçbiri tutmuyorsa
 * `unexplained` döner — tahmin yazılmaz.
 */
export function absenceReasons(
  probe: ProductProbe,
  sort: "balanced" | "best_deal",
  shownLimit: number,
): AbsenceReason[] {
  const reasons: AbsenceReason[] = [];
  if (probe.rank !== null) {
    if (probe.rank > shownLimit) {
      reasons.push({
        code: "below_limit",
        text: `Listede ama ${probe.rank}. sırada (ilk ${shownLimit} gösteriliyor); skor ${probe.score?.toFixed(4) ?? "—"}.`,
      });
    }
    return reasons;
  }
  if (probe.offers.total === 0) {
    reasons.push({ code: "no_offer", text: "Ürüne bağlı hiç teklif yok." });
  } else if (probe.offers.active === 0) {
    reasons.push({
      code: "no_active_offer",
      text: `${probe.offers.total} teklifin hiçbiri aktif değil.`,
    });
  } else if (probe.offers.activeOnActiveMerchant === 0) {
    reasons.push({
      code: "merchant_inactive",
      text: "Aktif teklifler yalnızca pasif mağazalarda.",
    });
  } else if (!probe.hasBestOffer) {
    reasons.push({
      code: "offer_filter",
      text: "Aktif teklif var ama sorgunun mağaza ya da stok koşuluna uyan yok.",
    });
  }
  if (probe.prefilterPass === false) {
    reasons.push({
      code: "prefilter",
      text: "Baş isim (son kelime) başlıkta, markada ya da ana kategori adında eşik üstü geçmiyor; ürün aday bile olmuyor.",
    });
  }
  if (probe.text && !probe.textGatePass) {
    const t = probe.text;
    reasons.push({
      code: "text_gate",
      text: `Metin kapısı: baş isim benzerliği ${t.head.toFixed(2)} (eşik ${TOKEN_MATCH_THRESHOLD}), eşleşen kelime ${t.matched}/${t.required} gerekli.`,
    });
  }
  for (const predicate of probe.predicates) {
    if (!predicate.pass) {
      reasons.push({
        code: "filter",
        filter: predicate.name,
        text: `Filtreye uymuyor: ${FILTER_LABELS[predicate.name] ?? predicate.name}.`,
      });
    }
  }
  if (sort === "best_deal") {
    if (!probe.priceStats.present) {
      reasons.push({
        code: "no_price_stats",
        text: '"En iyi fırsatlar" fiyat istatistiği olan ürünleri gösterir; bu ürünün yok.',
      });
    } else if (probe.priceStats.listPriceInflated) {
      reasons.push({
        code: "list_price_inflated",
        text: 'Liste fiyatı şişik işaretli; "En iyi fırsatlar" bu ürünleri dışarıda bırakır.',
      });
    }
  }
  if (probe.inCandidates && probe.hiddenByImageOf) {
    reasons.push({
      code: "image_duplicate",
      text: `Aynı görseli taşıyan daha yüksek skorlu ürün (#${probe.hiddenByImageOf.productId}) listede; aynı görselden tek kart gösterilir.`,
    });
  }
  if (reasons.length === 0) {
    reasons.push({
      code: "unexplained",
      text: "Ölçülen kapıların hepsinden geçiyor ama listede yok; kanıtlanabilir bir neden bulunamadı (veri ölçüm sırasında değişmiş olabilir).",
    });
  }
  return reasons;
}

export interface ProductAbsenceDiagnostics {
  input: string;
  queryNorm: string;
  effectiveSource: SearchDiagnostics["effectiveSource"];
  sort: "balanced" | "best_deal";
  shownLimit: number;
  /** Ürün bulunamadıysa null. */
  probe: ProductProbe | null;
  reasons: AbsenceReason[];
}

/**
 * "Bu ürün neden burada değil?" Salt okunur, zaman aşımlı; önbelleğe,
 * sayaca, analitiğe yazmaz. Çağıran tanı kotasını ayrıca tüketir.
 */
export async function explainProductAbsence(
  db: Database,
  actor: AdminActor,
  rawText: string,
  rawProductRef: string,
  sort: SortMode = "balanced",
): Promise<ProductAbsenceDiagnostics> {
  assertCapability(actor, "diagnostics.read");
  const input = typeof rawText === "string" ? rawText.trim() : "";
  if (input.length === 0 || input.length > DIAGNOSTIC_QUERY_MAX) {
    throw new SearchDiagnosticsInputError();
  }
  const ref = parseProductRef(rawProductRef);
  const textSort = sort === "best_deal" ? "best_deal" : "balanced";

  return readOnly(db, 8_000, async (tx) => {
    const rdb = tx as unknown as Database;
    const queryNorm = normalizeQueryText(input);
    let productId: number | null = null;
    if ("id" in ref) {
      productId = ref.id;
    } else {
      const found = await tx.execute<{ id: string }>(sql`
        SELECT id FROM product WHERE slug = ${ref.slug}
        UNION ALL
        SELECT product_id AS id FROM product_slug_history WHERE slug = ${ref.slug}
        LIMIT 1
      `);
      productId = found.rows[0] ? Number(found.rows[0].id) : null;
    }
    const { effectiveQuery, effectiveSource } = await resolveEffectiveQuery(rdb, input, queryNorm);
    const probe =
      productId === null
        ? null
        : await probeProduct(rdb, { ...effectiveQuery, sort: textSort }, textSort, productId);
    return {
      input,
      queryNorm,
      effectiveSource,
      sort: textSort,
      shownLimit: RESULT_LIMIT,
      probe,
      reasons: probe ? absenceReasons(probe, textSort, RESULT_LIMIT) : [],
    };
  });
}
