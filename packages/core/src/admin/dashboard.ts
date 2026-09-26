/**
 * `/yonetim` genel bakış. YALNIZCA veritabanında gerçekten var olan veri:
 * arama sayısı, sıfır sonuç oranı gibi metrikler burada YOKTUR çünkü arama
 * günlüğü tutulmuyor (docs/decisions/0039) — sahte ya da tahmini sayı
 * gösterilmez.
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
import { and, count, desc, eq, gte, inArray, isNull, sql, sum } from "drizzle-orm";
import { type AdminActor, assertCapability } from "./capabilities.ts";

/** ops.md §İzleme: bekleyen eşleştirme 500 üzeri → kuyruk incelemesi. */
export const MATCH_QUEUE_ALERT_THRESHOLD = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IngestAttentionItem {
  merchantId: number;
  merchantName: string;
  merchantSlug: string;
  status: "running" | "success" | "partial" | "failed";
  startedAt: Date;
}

export interface AdminOverview {
  generatedAt: Date;
  pendingMatches: number;
  /** Aktif ama henüz bir ürüne bağlanmamış teklifler. */
  unmatchedOffers: number;
  merchants: { active: number; total: number };
  ingest: {
    /** Son 24 saatte başlayan koşular, duruma göre. */
    runsLast24h: Record<string, number>;
    /** Son koşusu `failed` ya da `partial` biten merchant'lar. */
    attention: IngestAttentionItem[];
  };
  /** Son 7 gün, duruma göre. */
  linkRequests7d: Record<string, number>;
  imageUploads7d: Record<string, number>;
  apiUsage: {
    last24hCostMicros: number;
    last7dCostMicros: number;
    last7dCalls: number;
    last7dCacheHits: number;
  };
  newUsers7d: number;
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
    latestRuns,
    links,
    images,
    usage24h,
    usage7d,
    users,
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
    // merchant başına son koşu: `ingest_run_merchant_idx (merchant_id, started_at DESC)`.
    db
      .selectDistinctOn([ingestRun.merchantId], {
        merchantId: ingestRun.merchantId,
        status: ingestRun.status,
        startedAt: ingestRun.startedAt,
      })
      .from(ingestRun)
      .orderBy(ingestRun.merchantId, desc(ingestRun.startedAt)),
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
    db
      .select({ cost: sum(apiUsage.costMicros).mapWith(Number) })
      .from(apiUsage)
      .where(gte(apiUsage.createdAt, since24h)),
    db
      .select({
        cost: sum(apiUsage.costMicros).mapWith(Number),
        calls: count(),
        cacheHits: sql<number>`count(*) filter (where ${apiUsage.cacheHit})`.mapWith(Number),
      })
      .from(apiUsage)
      .where(gte(apiUsage.createdAt, since7d)),
    db.select({ n: count() }).from(appUser).where(gte(appUser.createdAt, since7d)),
  ]);

  const troubled = latestRuns.filter((run) => run.status === "failed" || run.status === "partial");
  const names =
    troubled.length > 0
      ? await db
          .select({ id: merchant.id, name: merchant.name, slug: merchant.slug })
          .from(merchant)
          .where(
            inArray(
              merchant.id,
              troubled.map((run) => run.merchantId),
            ),
          )
      : [];
  const byId = new Map(names.map((row) => [row.id, row]));

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
      attention: troubled
        .map((run) => ({
          merchantId: run.merchantId,
          merchantName: byId.get(run.merchantId)?.name ?? `#${run.merchantId}`,
          merchantSlug: byId.get(run.merchantId)?.slug ?? "",
          status: run.status,
          startedAt: run.startedAt,
        }))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
    },
    linkRequests7d: toRecord(links),
    imageUploads7d: toRecord(images),
    apiUsage: {
      last24hCostMicros: usage24h[0]?.cost ?? 0,
      last7dCostMicros: usage7d[0]?.cost ?? 0,
      last7dCalls: usage7d[0]?.calls ?? 0,
      last7dCacheHits: usage7d[0]?.cacheHits ?? 0,
    },
    newUsers7d: users[0]?.n ?? 0,
  };
}
