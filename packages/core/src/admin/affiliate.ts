/**
 * `/yonetim/affiliate` (karar 0085): mağaza çıkışı (attribution) toplamları ve
 * affiliate kapsamı.
 *
 * - `click` YALNIZCA attribution raporu olarak toplanır: mağaza, yüzey, kanal
 *   ve gün. `user_id`, `session_id` ve tekil satır hiç seçilmez; davranış
 *   analitiği ya da kullanıcı segmenti üretilmez (events.md, karar 0049 §5).
 * - Kapsam: `merchant.affiliate_status`, ağ, deeplink şablonu ve komisyon
 *   (yalnızca tanımlı mı; oran sıralamada belirleyici değildir, CLAUDE.md).
 * - Dönüşüm ve gelir: `conversion` tablosuna yazan entegrasyon yok (dış
 *   kaynak gerekli). Satır sayısı dürüstçe gösterilir; tahmin üretilmez.
 *
 * `click`'te `created_at` indeksi yok (karar 0085 "Sınırlar"): sorgular
 * salt okunur, zaman aşımlı ve pencere ile sınırlı; büyüyen hacimde indeks
 * migration'ı gerekir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { SEARCH_QUALITY_TIME_ZONE } from "../search/quality.ts";
import { type AnalyticsWindow, parseAnalyticsWindow } from "./ai-operations.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export interface AffiliateMerchantRow {
  merchantId: number;
  slug: string;
  name: string;
  clicks: number;
  affiliateStatus: string;
  network: string | null;
  hasDeeplink: boolean;
  hasCommission: boolean;
}

export interface AffiliateOverview {
  generatedAt: Date;
  days: AnalyticsWindow;
  totalClicks: number;
  creatorClicks: number;
  /** Etkin affiliate (status = active ve deeplink şablonu var) mağazaya giden çıkış. */
  clicksToActiveAffiliate: number;
  byMerchant: AffiliateMerchantRow[];
  bySurface: { surface: string; clicks: number }[];
  byChannel: { channel: string; clicks: number }[];
  byDay: { day: string; clicks: number }[];
  coverage: {
    merchants: number;
    byStatus: { status: string; count: number }[];
    withDeeplink: number;
    withCommission: number;
  };
  conversions: { total: number; inWindow: number };
}

type Num = string | number | null;
const n = (value: Num | undefined): number => Number(value ?? 0);

export async function getAffiliateOverview(
  db: Database,
  actor: AdminActor,
  options: { days?: unknown } = {},
  now: Date = new Date(),
): Promise<AffiliateOverview> {
  assertCapability(actor, "affiliate.read");
  const days = parseAnalyticsWindow(options.days, 30);
  const since = sql`(${now.toISOString()}::timestamptz - ${days}::int * interval '1 day')`;

  return readOnly(db, 8_000, async (tx) => {
    const totals = await tx.execute<{ total: Num; creator: Num; active_affiliate: Num }>(sql`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE c.creator_id IS NOT NULL) AS creator,
             count(*) FILTER (WHERE m.affiliate_status = 'active' AND m.deeplink_template IS NOT NULL)
               AS active_affiliate
        FROM click c
        JOIN offer o ON o.id = c.offer_id
        JOIN merchant m ON m.id = o.merchant_id
       WHERE c.created_at >= ${since}
    `);
    // Pencerede çıkışı olmayan mağazalar da listelenir (kapsam görünsün).
    const merchants = await tx.execute<{
      id: Num;
      slug: string;
      name: string;
      clicks: Num;
      status: string;
      network: string | null;
      deeplink: boolean;
      commission: boolean;
    }>(sql`
      SELECT m.id, m.slug, m.name, COALESCE(k.clicks, 0) AS clicks,
             m.affiliate_status AS status, m.affiliate_network AS network,
             (m.deeplink_template IS NOT NULL) AS deeplink,
             (m.commission_rate_bp IS NOT NULL) AS commission
        FROM merchant m
        LEFT JOIN (
          SELECT o.merchant_id, count(*) AS clicks
            FROM click c JOIN offer o ON o.id = c.offer_id
           WHERE c.created_at >= ${since}
           GROUP BY o.merchant_id
        ) k ON k.merchant_id = m.id
       ORDER BY COALESCE(k.clicks, 0) DESC, m.name
       LIMIT 200
    `);
    const surfaces = await tx.execute<{ surface: string | null; clicks: Num }>(sql`
      SELECT surface, count(*) AS clicks FROM click
       WHERE created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC
    `);
    const channels = await tx.execute<{ channel: string; clicks: Num }>(sql`
      SELECT channel, count(*) AS clicks FROM click
       WHERE created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC
    `);
    const daily = await tx.execute<{ day: string; clicks: Num }>(sql`
      SELECT to_char((created_at AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date, 'YYYY-MM-DD') AS day,
             count(*) AS clicks
        FROM click
       WHERE created_at >= ${since}
       GROUP BY 1 ORDER BY 1 DESC
    `);
    const coverage = await tx.execute<{
      merchants: Num;
      deeplink: Num;
      commission: Num;
    }>(sql`
      SELECT count(*) AS merchants,
             count(*) FILTER (WHERE deeplink_template IS NOT NULL) AS deeplink,
             count(*) FILTER (WHERE commission_rate_bp IS NOT NULL) AS commission
        FROM merchant
    `);
    const statuses = await tx.execute<{ status: string; count: Num }>(sql`
      SELECT affiliate_status AS status, count(*) AS count FROM merchant GROUP BY 1 ORDER BY 2 DESC
    `);
    const conversions = await tx.execute<{ total: Num; in_window: Num }>(sql`
      SELECT count(*) AS total, count(*) FILTER (WHERE created_at >= ${since}) AS in_window
        FROM conversion
    `);

    const totalRow = totals.rows[0];
    const coverageRow = coverage.rows[0];
    return {
      generatedAt: now,
      days,
      totalClicks: n(totalRow?.total),
      creatorClicks: n(totalRow?.creator),
      clicksToActiveAffiliate: n(totalRow?.active_affiliate),
      byMerchant: merchants.rows.map((row) => ({
        merchantId: n(row.id),
        slug: row.slug,
        name: row.name,
        clicks: n(row.clicks),
        affiliateStatus: row.status,
        network: row.network,
        hasDeeplink: row.deeplink === true,
        hasCommission: row.commission === true,
      })),
      bySurface: surfaces.rows.map((row) => ({
        surface: row.surface ?? "belirtilmemiş",
        clicks: n(row.clicks),
      })),
      byChannel: channels.rows.map((row) => ({ channel: row.channel, clicks: n(row.clicks) })),
      byDay: daily.rows.map((row) => ({ day: row.day, clicks: n(row.clicks) })),
      coverage: {
        merchants: n(coverageRow?.merchants),
        byStatus: statuses.rows.map((row) => ({ status: row.status, count: n(row.count) })),
        withDeeplink: n(coverageRow?.deeplink),
        withCommission: n(coverageRow?.commission),
      },
      conversions: {
        total: n(conversions.rows[0]?.total),
        inWindow: n(conversions.rows[0]?.in_window),
      },
    };
  });
}
