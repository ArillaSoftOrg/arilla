/**
 * `/yonetim` genel bakış. YALNIZCA veritabanında gerçekten var olan veri;
 * sahte ya da tahmini sayı gösterilmez (docs/decisions/0039). Arama sayıları
 * kimliksiz günlük özetten (`search_query_day`, karar 0052) gelir: yalnızca
 * `/ara` metin araması; sohbet ve fotoğraf araması bu sayıya girmez.
 *
 * Her sorgu sınırlı: sayımlar kısmi indekslerden (`match_candidate_pending_idx`,
 * `offer_unmatched_idx`), zaman pencereli toplamlar son 24 saat / 7 gün.
 */
import {
  apiUsage,
  appUser,
  type Database,
  imageUpload,
  ingestRun,
  linkResolutionRequest,
  matchCandidate,
  merchant,
  offer,
} from "@arilla/db";
import { and, count, eq, gte, isNull, sql, sum } from "drizzle-orm";
import { SEARCH_QUALITY_TIME_ZONE } from "../search/quality.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import type { CostSummary } from "./cost-truth.ts";
import { listMerchantAttention, type MerchantAttentionItem } from "./merchant-attention.ts";

/** ops.md §İzleme: bekleyen eşleştirme 500 üzeri → kuyruk incelemesi. */
export const MATCH_QUEUE_ALERT_THRESHOLD = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AdminOverview {
  generatedAt: Date;
  pendingMatches: number;
  /** Aktif ama henüz bir ürüne bağlanmamış teklifler. */
  unmatchedOffers: number;
  merchants: { active: number; total: number };
  ingest: {
    /** Son 24 saatte başlayan koşular, duruma göre. */
    runsLast24h: Record<string, number>;
    /** Aktif mağazalardan dikkat gerektirenler (karar 0051, `merchant-attention.ts`). */
    attention: MerchantAttentionItem[];
  };
  /** Son 7 gün, duruma göre. */
  linkRequests7d: Record<string, number>;
  imageUploads7d: Record<string, number>;
  /** Maliyet tek başına sayı değildir: fiyatlanmamış çağrılar ayrıca sayılır (`cost-truth.ts`). */
  apiUsage: {
    last24h: CostSummary;
    last7d: CostSummary;
  };
  newUsers7d: number;
  /**
   * Bugün dahil son 7 takvim günü (Europe/Istanbul), `search_query_day`
   * toplamı. Kimlik yok; e-posta/telefon içeren sorgular hiç yazılmaz (0052).
   */
  textSearch7d: { searches: number; zeroResults: number; fallbacks: number };
}

/** `api_usage` toplamı; fiyatlanmamış çağrı = önbellekten değil ama maliyeti 0. */
const COST_COLUMNS = {
  costMicros: sum(apiUsage.costMicros).mapWith(Number),
  calls: count(),
  cacheHits: sql<number>`count(*) filter (where ${apiUsage.cacheHit})`.mapWith(Number),
  units: sum(apiUsage.units).mapWith(Number),
  unpricedCalls:
    sql<number>`count(*) filter (where not ${apiUsage.cacheHit} and ${apiUsage.costMicros} = 0)`.mapWith(
      Number,
    ),
};

function toCost(row: Partial<CostSummary> | undefined): CostSummary {
  return {
    costMicros: row?.costMicros ?? 0,
    calls: row?.calls ?? 0,
    cacheHits: row?.cacheHits ?? 0,
    units: row?.units ?? 0,
    unpricedCalls: row?.unpricedCalls ?? 0,
  };
}

function toRecord(rows: { key: string; n: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.n)]));
}

export async function getAdminOverview(db: Database, actor: AdminActor): Promise<AdminOverview> {
  assertCapability(actor, "admin.access");

  const now = new Date();
  const since24h = new Date(now.getTime() - DAY_MS);
  const since7d = new Date(now.getTime() - 7 * DAY_MS);

  const [
    pending,
    unmatched,
    merchantCounts,
    runs24h,
    attention,
    links,
    images,
    usage24h,
    usage7d,
    users,
    searchDays,
  ] = await Promise.all([
    db.select({ n: count() }).from(matchCandidate).where(eq(matchCandidate.status, "pending")),
    db
      .select({ n: count() })
      .from(offer)
      .where(and(isNull(offer.productId), eq(offer.isActive, true))),
    db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${merchant.isActive})`.mapWith(Number),
      })
      .from(merchant),
    db
      .select({ key: ingestRun.status, n: count() })
      .from(ingestRun)
      .where(gte(ingestRun.startedAt, since24h))
      .groupBy(ingestRun.status),
    // Yalnızca aktif mağazalar, mağaza başına LATERAL tek satır (tüm koşular taranmaz).
    listMerchantAttention(db, actor, now),
    db
      .select({ key: linkResolutionRequest.status, n: count() })
      .from(linkResolutionRequest)
      .where(gte(linkResolutionRequest.createdAt, since7d))
      .groupBy(linkResolutionRequest.status),
    db
      .select({ key: imageUpload.status, n: count() })
      .from(imageUpload)
      .where(gte(imageUpload.createdAt, since7d))
      .groupBy(imageUpload.status),
    db.select(COST_COLUMNS).from(apiUsage).where(gte(apiUsage.createdAt, since24h)),
    db.select(COST_COLUMNS).from(apiUsage).where(gte(apiUsage.createdAt, since7d)),
    db.select({ n: count() }).from(appUser).where(gte(appUser.createdAt, since7d)),
    // (day, query_norm) birincil anahtarının ön eki: 7 günlük aralık taraması.
    db.execute<{ searches: number; zero_results: number; fallbacks: number }>(sql`
      SELECT COALESCE(sum(searches), 0)::int AS searches,
             COALESCE(sum(zero_results), 0)::int AS zero_results,
             COALESCE(sum(fallbacks), 0)::int AS fallbacks
      FROM search_query_day
      WHERE day >= ((${now.toISOString()}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date - 6)
    `),
  ]);
  const searchRow = searchDays.rows[0];

  return {
    generatedAt: now,
    pendingMatches: pending[0]?.n ?? 0,
    unmatchedOffers: unmatched[0]?.n ?? 0,
    merchants: {
      active: merchantCounts[0]?.active ?? 0,
      total: merchantCounts[0]?.total ?? 0,
    },
    ingest: {
      runsLast24h: toRecord(runs24h),
      attention,
    },
    linkRequests7d: toRecord(links),
    imageUploads7d: toRecord(images),
    apiUsage: {
      last24h: toCost(usage24h[0]),
      last7d: toCost(usage7d[0]),
    },
    newUsers7d: users[0]?.n ?? 0,
    textSearch7d: {
      searches: Number(searchRow?.searches ?? 0),
      zeroResults: Number(searchRow?.zero_results ?? 0),
      fallbacks: Number(searchRow?.fallbacks ?? 0),
    },
  };
}
