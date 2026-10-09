/**
 * Mevcut tanı sayfalarına eklenen özetler (karar 0085). Yeni ekran açmaz;
 * var olan sayfaların üstünde tek bakışta gösterilir ve aynı yetenekle okunur:
 *
 * - `getSearchQualitySummary` → `/yonetim/arama/tani` (`diagnostics.read`):
 *   kimliksiz arama özeti (`search_query_day`) + Gemini sorgu yorumunun
 *   sonuç dağılımı (`query_interpretation`).
 * - `getMatchingAccuracy` → `/yonetim/eslestirme/gecmis` (`matching.review`):
 *   pencere içindeki insan kararları; yönteme ve skor bandına göre kabul/red.
 * - `getCatalogFreshness` → `/yonetim/katalog/kalite` (`catalog.read`):
 *   aktif teklif tazeliği, stok, görsel durumu ve liste fiyatı şişirme.
 *   Tazelik eşiği mevcut iş kuralıdır (`STALE_OFFER_DAYS`).
 *
 * Hepsi salt okunur, zaman aşımlı ve toplam üretir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { SEARCH_QUALITY_TIME_ZONE } from "../search/quality.ts";
import { type AnalyticsWindow, parseAnalyticsWindow } from "./ai-operations.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { STALE_OFFER_DAYS } from "./catalog.ts";

type Num = string | number | null;
const n = (value: Num | undefined): number => Number(value ?? 0);

export interface SearchQualitySummary {
  days: AnalyticsWindow;
  searches: number;
  zeroResults: number;
  fallbacks: number;
  clarifications: number;
  distinctQueries: number;
  interpretation: { status: string; count: number }[];
}

export async function getSearchQualitySummary(
  db: Database,
  actor: AdminActor,
  options: { days?: unknown } = {},
  now: Date = new Date(),
): Promise<SearchQualitySummary> {
  assertCapability(actor, "diagnostics.read");
  const days = parseAnalyticsWindow(options.days, 7);
  const at = now.toISOString();
  const sinceDay = sql`((${at}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date - ${days - 1}::int)`;
  return readOnly(db, 5_000, async (tx) => {
    const totals = await tx.execute<{
      searches: Num;
      zero: Num;
      fallbacks: Num;
      clarifications: Num;
      queries: Num;
    }>(sql`
      SELECT COALESCE(sum(searches), 0) AS searches, COALESCE(sum(zero_results), 0) AS zero,
             COALESCE(sum(fallbacks), 0) AS fallbacks, COALESCE(sum(clarifications), 0) AS clarifications,
             count(DISTINCT query_norm) AS queries
        FROM search_query_day
       WHERE day >= ${sinceDay}
    `);
    const interpretation = await tx.execute<{ status: string; count: Num }>(sql`
      SELECT status, count(*) AS count
        FROM query_interpretation
       WHERE created_at >= (${at}::timestamptz - ${days}::int * interval '1 day')
       GROUP BY 1 ORDER BY 2 DESC
    `);
    const row = totals.rows[0];
    return {
      days,
      searches: n(row?.searches),
      zeroResults: n(row?.zero),
      fallbacks: n(row?.fallbacks),
      clarifications: n(row?.clarifications),
      distinctQueries: n(row?.queries),
      interpretation: interpretation.rows.map((r) => ({ status: r.status, count: n(r.count) })),
    };
  });
}

/** Skor bantları: otomatik kabul eşiği (0017) ve inceleme alt sınırı çevresi. */
export const MATCH_SCORE_BANDS = [
  { key: "lt_063", label: "< 0,63", min: null, max: 0.63 },
  { key: "063_070", label: "0,63–0,70", min: 0.63, max: 0.7 },
  { key: "070_080", label: "0,70–0,80", min: 0.7, max: 0.8 },
  { key: "080_084", label: "0,80–0,84", min: 0.8, max: 0.84 },
  { key: "ge_084", label: "≥ 0,84", min: 0.84, max: null },
] as const;

export interface MatchingAccuracy {
  days: AnalyticsWindow;
  /** İnsan kararı: `accepted` ya da `rejected` (otomatik kabul ayrı). */
  byMethod: { method: string; accepted: number; rejected: number }[];
  byBand: { band: string; label: string; accepted: number; rejected: number }[];
  rejectReasons: { reason: string; count: number }[];
  autoAccepted: number;
  pending: number;
}

export async function getMatchingAccuracy(
  db: Database,
  actor: AdminActor,
  options: { days?: unknown } = {},
  now: Date = new Date(),
): Promise<MatchingAccuracy> {
  assertCapability(actor, "matching.review");
  const days = parseAnalyticsWindow(options.days, 30);
  const since = sql`(${now.toISOString()}::timestamptz - ${days}::int * interval '1 day')`;
  const bandCase = sql.raw(
    `CASE ${MATCH_SCORE_BANDS.map((band) => {
      const parts = [
        band.min === null ? null : `score >= ${band.min}`,
        band.max === null ? null : `score < ${band.max}`,
      ].filter(Boolean);
      return `WHEN ${parts.join(" AND ")} THEN '${band.key}'`;
    }).join(" ")} END`,
  );
  return readOnly(db, 5_000, async (tx) => {
    const methods = await tx.execute<{ method: string; accepted: Num; rejected: Num }>(sql`
      SELECT method,
             count(*) FILTER (WHERE status = 'accepted') AS accepted,
             count(*) FILTER (WHERE status = 'rejected') AS rejected
        FROM match_candidate
       WHERE status IN ('accepted', 'rejected') AND reviewed_at >= ${since}
       GROUP BY 1 ORDER BY 1
    `);
    const bands = await tx.execute<{ band: string; accepted: Num; rejected: Num }>(sql`
      SELECT ${bandCase} AS band,
             count(*) FILTER (WHERE status = 'accepted') AS accepted,
             count(*) FILTER (WHERE status = 'rejected') AS rejected
        FROM match_candidate
       WHERE status IN ('accepted', 'rejected') AND reviewed_at >= ${since}
       GROUP BY 1
    `);
    const reasons = await tx.execute<{ reason: string | null; count: Num }>(sql`
      SELECT review_reason AS reason, count(*) AS count
        FROM match_candidate
       WHERE status = 'rejected' AND reviewed_at >= ${since}
       GROUP BY 1 ORDER BY 2 DESC
    `);
    const other = await tx.execute<{ auto: Num; pending: Num }>(sql`
      SELECT count(*) FILTER (WHERE status = 'auto_accepted' AND created_at >= ${since}) AS auto,
             count(*) FILTER (WHERE status = 'pending') AS pending
        FROM match_candidate
    `);
    return {
      days,
      byMethod: methods.rows.map((r) => ({
        method: r.method,
        accepted: n(r.accepted),
        rejected: n(r.rejected),
      })),
      byBand: MATCH_SCORE_BANDS.map((band) => {
        const row = bands.rows.find((r) => r.band === band.key);
        return {
          band: band.key,
          label: band.label,
          accepted: n(row?.accepted),
          rejected: n(row?.rejected),
        };
      }),
      rejectReasons: reasons.rows.map((r) => ({
        reason: r.reason ?? "nedensiz",
        count: n(r.count),
      })),
      autoAccepted: n(other.rows[0]?.auto),
      pending: n(other.rows[0]?.pending),
    };
  });
}

export interface CatalogFreshness {
  activeOffers: number;
  seen24h: number;
  seen7d: number;
  staleOffers: number;
  inStock: number;
  outOfStock: number;
  images: { status: string; count: number }[];
  activeOffersWithoutImage: number;
  inflatedListPrice: number;
  staleOfferDays: number;
}

export async function getCatalogFreshness(
  db: Database,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<CatalogFreshness> {
  assertCapability(actor, "catalog.read");
  const at = sql`${now.toISOString()}::timestamptz`;
  return readOnly(db, 8_000, async (tx) => {
    const offers = await tx.execute<{
      active: Num;
      seen24h: Num;
      seen7d: Num;
      stale: Num;
      in_stock: Num;
      out_of_stock: Num;
      no_image: Num;
    }>(sql`
      SELECT count(*) AS active,
             count(*) FILTER (WHERE o.last_seen_at >= ${at} - interval '1 day') AS seen24h,
             count(*) FILTER (WHERE o.last_seen_at >= ${at} - interval '7 days') AS seen7d,
             count(*) FILTER (WHERE o.last_seen_at < ${at} - (${STALE_OFFER_DAYS} * interval '1 day')) AS stale,
             count(*) FILTER (WHERE o.in_stock) AS in_stock,
             count(*) FILTER (WHERE NOT o.in_stock) AS out_of_stock,
             count(*) FILTER (WHERE o.image_url IS NULL AND NOT EXISTS (
               SELECT 1 FROM offer_image i WHERE i.offer_id = o.id AND i.status = 'active'
             )) AS no_image
        FROM offer o
       WHERE o.is_active
    `);
    const images = await tx.execute<{ status: string; count: Num }>(sql`
      SELECT status, count(*) AS count FROM offer_image GROUP BY 1 ORDER BY 2 DESC
    `);
    const inflated = await tx.execute<{ count: Num }>(sql`
      SELECT count(*) AS count FROM product_price_stats WHERE list_price_inflated
    `);
    const row = offers.rows[0];
    return {
      activeOffers: n(row?.active),
      seen24h: n(row?.seen24h),
      seen7d: n(row?.seen7d),
      staleOffers: n(row?.stale),
      inStock: n(row?.in_stock),
      outOfStock: n(row?.out_of_stock),
      images: images.rows.map((r) => ({ status: r.status, count: n(r.count) })),
      activeOffersWithoutImage: n(row?.no_image),
      inflatedListPrice: n(inflated.rows[0]?.count),
      staleOfferDays: STALE_OFFER_DAYS,
    };
  });
}
