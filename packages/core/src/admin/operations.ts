/**
 * `/yonetim/islemler` (Faz 5): işletim sağlığı. docs/ops.md §İzleme'deki
 * eşiklerin veritabanından okunabilenleri.
 *
 * Kavram ayrımı (docs/decisions/0039 madde 6): burası İŞLETİM sinyalidir.
 * Denetim kaydı `/yonetim/denetim`'de, analitik sağlayıcıda, hatalar hata
 * takip servisindedir; genel bir `logs` tablosu YOKTUR ve kurulmaz.
 *
 * İş (cron) geçmişi tablosu yok (`job_run` ertelendi). İşlerin sağlığı
 * ürettikleri verinin tazeliğinden okunur ve öyle etiketlenir: "son kanıt",
 * "son çalıştı" değil. Yeniden deneme / çalıştır düğmesi YOK.
 *
 * Her denetim kendi salt okunur, zaman aşımlı işleminde çalışır: biri
 * zaman aşımına uğrarsa diğerleri yine görünür.
 */
import {
  type Database,
  ORPHAN_SQL,
  type OrphanGroup,
  type OrphanRow,
  toOrphanGroup,
} from "@arilla/db";
import { sql } from "drizzle-orm";
import { LINK_RESOLUTION_QUEUE_KEY } from "../discovery/link-resolution.ts";
import { getRedis } from "../redis/client.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { MATCH_QUEUE_ALERT_THRESHOLD } from "./dashboard.ts";

/** docs/ops.md: içinde bulunulan ay + 3 ay ileri partition hazır olmalı. */
export const PARTITION_MONTHS_AHEAD = 3;

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

async function check<T>(fn: () => Promise<T>): Promise<Check<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code;
    return {
      ok: false,
      error: code === "57014" ? "Zaman aşımı" : "Denetim çalıştırılamadı",
    };
  }
}

export interface PartitionRange {
  name: string;
  from: Date;
  to: Date;
}

export interface PartitionHealth {
  ranges: PartitionRange[];
  hasDefault: boolean;
  /** Bugünden itibaren kesintisiz kapsanan tam ay sayısı (bu ay dahil değil). */
  monthsAhead: number;
  /** Aylık aralıklar arasındaki boşluklar (varsa satırlar default'a düşer). */
  gaps: { from: Date; to: Date }[];
  /** Hiçbir aylık partition'ın kapsamadığı zamana düşen satır (≈ default dolu). 10.001'de kesilir. */
  uncoveredRows: number;
}

const BOUND = /FROM \('([^']+)'\) TO \('([^']+)'\)/;

/**
 * `price_point_default`'a `arilla_app`'in doğrudan erişimi yok (0010). Doluluk,
 * ebeveyn tablo üzerinden hiçbir aylık aralığın kapsamadığı zamanlar
 * sorgulanarak ölçülür: planlayıcı bu koşulu yalnızca default'a budar.
 */
export async function partitionHealth(db: Database, now = new Date()): Promise<PartitionHealth> {
  return readOnly(db, 5_000, async (tx) => {
    const parts = await tx.execute<{ relname: string; bound: string }>(sql`
      SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'price_point'::regclass
    `);
    let hasDefault = false;
    const ranges: PartitionRange[] = [];
    for (const part of parts.rows) {
      if (part.bound === "DEFAULT") {
        hasDefault = true;
        continue;
      }
      const match = BOUND.exec(part.bound);
      if (match?.[1] && match[2]) {
        ranges.push({ name: part.relname, from: new Date(match[1]), to: new Date(match[2]) });
      }
    }
    ranges.sort((a, b) => a.from.getTime() - b.from.getTime());

    const gaps: { from: Date; to: Date }[] = [];
    for (let i = 1; i < ranges.length; i++) {
      const prev = ranges[i - 1];
      const cur = ranges[i];
      if (prev && cur && prev.to.getTime() < cur.from.getTime()) {
        gaps.push({ from: prev.to, to: cur.from });
      }
    }

    // Bu ayın başından itibaren kesintisiz kapsanan sınır.
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    let coveredUntil = monthStart;
    for (const range of ranges) {
      if (range.from.getTime() <= coveredUntil.getTime() && range.to > coveredUntil) {
        coveredUntil = range.to;
      }
    }
    const monthsAhead =
      coveredUntil > monthStart
        ? (coveredUntil.getUTCFullYear() - monthStart.getUTCFullYear()) * 12 +
          (coveredUntil.getUTCMonth() - monthStart.getUTCMonth()) -
          1
        : -1;

    let uncoveredRows = 0;
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    if (first && last) {
      const uncovered = [
        sql`observed_at < ${first.from.toISOString()}::timestamptz`,
        sql`observed_at >= ${last.to.toISOString()}::timestamptz`,
        ...gaps.map(
          (gap) =>
            sql`(observed_at >= ${gap.from.toISOString()}::timestamptz AND observed_at < ${gap.to.toISOString()}::timestamptz)`,
        ),
      ];
      const count = await tx.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM (
          SELECT 1 FROM price_point WHERE ${sql.join(uncovered, sql` OR `)} LIMIT 10001
        ) t
      `);
      uncoveredRows = Number(count.rows[0]?.n ?? 0);
    }

    return { ranges, hasDefault, monthsAhead, gaps, uncoveredRows };
  });
}

export interface CostRow {
  day: string;
  operation: string;
  calls: number;
  cacheHits: number;
  costMicros: number;
}

/** `api_usage`, son 14 gün, gün (İstanbul) ve işleme göre. `api_usage_daily_idx`. */
export async function costByDay(db: Database): Promise<CostRow[]> {
  return readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<{
      day: string;
      operation: string;
      calls: string;
      hits: string;
      cost: string | null;
    }>(sql`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Europe/Istanbul'), 'YYYY-MM-DD') AS day,
             operation, count(*) AS calls, count(*) FILTER (WHERE cache_hit) AS hits,
             sum(cost_micros) AS cost
        FROM api_usage
       WHERE created_at >= now() - interval '14 days'
       GROUP BY 1, 2
       ORDER BY 1 DESC, 2
       LIMIT 500
    `);
    return result.rows.map((row) => ({
      day: row.day,
      operation: row.operation,
      calls: Number(row.calls),
      cacheHits: Number(row.hits),
      costMicros: Number(row.cost ?? 0),
    }));
  });
}

export interface ComplianceHealth {
  /** KVKK: `purge_after` geçmiş ama ham dosya hâlâ depoda. Beklenen 0. */
  imagePurgeOverdue: number;
  /** Süresi geçmiş, kullanılmamış giriş bağlantısı (temizlik işi kanıtı). */
  expiredLoginTokens: number;
  expiredPhoneCodes: number;
}

export async function complianceHealth(db: Database): Promise<ComplianceHealth> {
  return readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<{ purge: string; tokens: string; codes: string }>(sql`
      SELECT
        (SELECT count(*) FROM image_upload
          WHERE object_key IS NOT NULL AND purge_after < now()) AS purge,
        (SELECT count(*) FROM auth_token
          WHERE consumed_at IS NULL AND expires_at < now() - interval '1 day') AS tokens,
        (SELECT count(*) FROM phone_login_code
          WHERE consumed_at IS NULL AND expires_at < now() - interval '1 day') AS codes
    `);
    const row = result.rows[0];
    return {
      imagePurgeOverdue: Number(row?.purge ?? 0),
      expiredLoginTokens: Number(row?.tokens ?? 0),
      expiredPhoneCodes: Number(row?.codes ?? 0),
    };
  });
}

export interface JobEvidence {
  /** `generate-discovery-slots` (Vercel cron, gece yarısı): en ileri `slot_date`. */
  latestDiscoverySlot: string | null;
  /** `trigger-alerts` (GitHub Actions, 15 dk): son bildirim. */
  lastAlertNotifiedAt: Date | null;
  activeAlerts: number;
  /** Veri toplama: son koşu başlangıcı ve 2 saatten uzun `running` kalan koşu. */
  lastIngestStartedAt: Date | null;
  stuckIngestRuns: number;
  /** Gece fiyat istatistiği işi. */
  lastPriceStatsAt: Date | null;
  pendingMatches: number;
  matchQueueThreshold: number;
}

export async function jobEvidence(db: Database): Promise<JobEvidence> {
  return readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<{
      slot: string | null;
      notified: string | null;
      active_alerts: string;
      last_ingest: string | null;
      stuck: string;
      stats: string | null;
      pending: string;
    }>(sql`
      SELECT
        (SELECT to_char(max(slot_date), 'YYYY-MM-DD') FROM discovery_slot) AS slot,
        (SELECT max(notified_at) FROM alert) AS notified,
        (SELECT count(*) FROM alert WHERE is_active) AS active_alerts,
        (SELECT max(started_at) FROM ingest_run) AS last_ingest,
        (SELECT count(*) FROM ingest_run
          WHERE status = 'running' AND started_at < now() - interval '2 hours') AS stuck,
        (SELECT max(computed_at) FROM product_price_stats) AS stats,
        (SELECT count(*) FROM match_candidate WHERE status = 'pending') AS pending
    `);
    const row = result.rows[0];
    const date = (value: string | null | undefined) => (value ? new Date(value) : null);
    return {
      latestDiscoverySlot: row?.slot ?? null,
      lastAlertNotifiedAt: date(row?.notified),
      activeAlerts: Number(row?.active_alerts ?? 0),
      lastIngestStartedAt: date(row?.last_ingest),
      stuckIngestRuns: Number(row?.stuck ?? 0),
      lastPriceStatsAt: date(row?.stats),
      pendingMatches: Number(row?.pending ?? 0),
      matchQueueThreshold: MATCH_QUEUE_ALERT_THRESHOLD,
    };
  });
}

/**
 * Link çözümleme kuyruğunun Redis'teki uzunluğu. Redis yoksa ya da 2 sn'de
 * cevap vermezse hata olarak döner; sayfa beklemez.
 */
export async function linkQueueDepth(timeoutMs = 2_000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("redis zaman aşımı")), timeoutMs);
  });
  try {
    return await Promise.race([getRedis().llen(LINK_RESOLUTION_QUEUE_KEY), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface OperationsOverview {
  generatedAt: Date;
  partitions: Check<PartitionHealth>;
  cost: Check<CostRow[]>;
  compliance: Check<ComplianceHealth>;
  jobs: Check<JobEvidence>;
  linkQueue: Check<number>;
}

export async function getOperationsOverview(
  db: Database,
  actor: AdminActor,
): Promise<OperationsOverview> {
  assertCapability(actor, "operations.read");
  const [partitions, cost, compliance, jobs, linkQueue] = await Promise.all([
    check(() => partitionHealth(db)),
    check(() => costByDay(db)),
    check(() => complianceHealth(db)),
    check(() => jobEvidence(db)),
    check(() => linkQueueDepth()),
  ]);
  return { generatedAt: new Date(), partitions, cost, compliance, jobs, linkQueue };
}

/**
 * Polimorfik yetim taraması (`pnpm db:orphans` ile AYNI SQL). Tam tablo
 * karşılaştırması olduğu için yalnızca istenince çalışır, 10 sn sınırlı.
 */
export async function runOrphanCheck(
  db: Database,
  actor: AdminActor,
): Promise<Check<OrphanGroup[]>> {
  assertCapability(actor, "operations.read");
  return check(() =>
    readOnly(db, 10_000, async (tx) => {
      const result = await tx.execute<OrphanRow & Record<string, unknown>>(sql.raw(ORPHAN_SQL));
      return result.rows.map(toOrphanGroup);
    }),
  );
}
