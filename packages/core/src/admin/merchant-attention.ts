/**
 * "Dikkat gerektiren mağazalar" (docs/decisions/0051). Yalnızca AKTİF
 * mağazalar; pasif mağaza bilerek kapatılmıştır, bir sorun değildir.
 *
 * Durumlar (bir mağazada birden çok olabilir; önem sırasıyla):
 * - `stuck`: son koşu 2 saattir `running` — süreç çökmüş, koşu kapanmamış.
 * - `failed`: son koşu başarısız (`refused:` kapı reddi dahil).
 * - `currency_unverified`: Shopify mağazasının para birimi doğrulanmamış;
 *   toplama kapısı (`collect/gate.py`) koşuyu reddeder.
 * - `never_ran`: hiç toplama koşusu yok.
 * - `stale`: veri `STALE_AFTER` süresinden uzun süredir yenilenmedi
 *   (ops.md §İzleme "feed'siz geçen süre 24 saat"; mağazanın kendi
 *   `refresh_minutes` aralığı daha uzunsa o).
 *
 * `partial` tek başına dikkat durumu DEĞİLDİR: tek bir reddedilen kayıt bile
 * koşuyu kısmi yapar, veri yine yazılmıştır. Kısmi koşu tazelik için başarılı
 * sayılır.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { feedConfigView, type IngestStatus } from "./merchants.ts";

export const STUCK_RUN_AFTER_MS = 2 * 60 * 60 * 1000;
/** ops.md §İzleme: feed'siz geçen süre eşiği. */
export const STALE_FEED_AFTER_MS = 24 * 60 * 60 * 1000;

export const ATTENTION_STATES = [
  "stuck",
  "failed",
  "currency_unverified",
  "never_ran",
  "stale",
] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

export interface MerchantAttentionInput {
  sourceType: string;
  currencyVerified: boolean;
  refreshMinutes: number;
  lastRun: { status: IngestStatus; startedAt: Date } | null;
  /** Son `success` ya da `partial` koşunun başlangıcı (veri yazılmış). */
  lastGoodAt: Date | null;
}

/** Saf: tek mağazanın dikkat durumları, önem sırasıyla. Boşsa sorun yok. */
export function classifyMerchantAttention(
  input: MerchantAttentionInput,
  now: Date = new Date(),
): AttentionState[] {
  const states: AttentionState[] = [];
  const run = input.lastRun;
  if (run?.status === "running" && now.getTime() - run.startedAt.getTime() > STUCK_RUN_AFTER_MS) {
    states.push("stuck");
  }
  if (run?.status === "failed") states.push("failed");
  if (input.sourceType === "shopify" && !input.currencyVerified) {
    states.push("currency_unverified");
  }
  if (!run) {
    states.push("never_ran");
  } else {
    const staleAfter = Math.max(STALE_FEED_AFTER_MS, input.refreshMinutes * 60 * 1000);
    if (!input.lastGoodAt || now.getTime() - input.lastGoodAt.getTime() > staleAfter) {
      states.push("stale");
    }
  }
  return states;
}

export interface MerchantAttentionItem {
  merchantId: number;
  merchantName: string;
  merchantSlug: string;
  states: AttentionState[];
  lastRun: { status: IngestStatus; startedAt: Date } | null;
  lastGoodAt: Date | null;
  /** Son başarılı koşudan bu yana başarısız koşu sayısı. */
  failuresSinceSuccess: number;
}

type AttentionSqlRow = {
  id: string;
  name: string;
  slug: string;
  source_type: string;
  refresh_minutes: number;
  feed_config: unknown;
  last_status: IngestStatus | null;
  last_started_at: string | null;
  last_good_at: string | null;
  failures_since_success: string;
};

const SEVERITY: Record<AttentionState, number> = {
  stuck: 0,
  failed: 1,
  currency_unverified: 2,
  never_ran: 3,
  stale: 4,
};

/**
 * Aktif mağazalar için dikkat listesi. Mağaza başına iki LATERAL alt sorgu
 * `ingest_run_merchant_idx (merchant_id, started_at DESC)` ile tek satır okur;
 * tüm `ingest_run` taranmaz.
 */
export async function listMerchantAttention(
  db: Database,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<MerchantAttentionItem[]> {
  assertCapability(actor, "admin.access");
  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<AttentionSqlRow>(sql`
      SELECT m.id, m.name, m.slug, m.source_type, m.refresh_minutes, m.feed_config,
             lr.status AS last_status, lr.started_at AS last_started_at,
             lg.started_at AS last_good_at,
             (SELECT count(*) FROM ingest_run r
               WHERE r.merchant_id = m.id AND r.status = 'failed'
                 AND r.started_at > coalesce(ls.started_at, '-infinity'::timestamptz)
             ) AS failures_since_success
        FROM merchant m
        LEFT JOIN LATERAL (
          SELECT r.status, r.started_at FROM ingest_run r
           WHERE r.merchant_id = m.id ORDER BY r.started_at DESC LIMIT 1
        ) lr ON true
        LEFT JOIN LATERAL (
          SELECT r.started_at FROM ingest_run r
           WHERE r.merchant_id = m.id AND r.status IN ('success','partial')
           ORDER BY r.started_at DESC LIMIT 1
        ) lg ON true
        LEFT JOIN LATERAL (
          SELECT r.started_at FROM ingest_run r
           WHERE r.merchant_id = m.id AND r.status = 'success'
           ORDER BY r.started_at DESC LIMIT 1
        ) ls ON true
       WHERE m.is_active
       ORDER BY m.name
       LIMIT 500
    `);
    return result.rows;
  });

  const items: MerchantAttentionItem[] = [];
  for (const row of rows) {
    const feed = feedConfigView(row.feed_config);
    const lastRun =
      row.last_status && row.last_started_at
        ? { status: row.last_status, startedAt: new Date(row.last_started_at) }
        : null;
    const lastGoodAt = row.last_good_at ? new Date(row.last_good_at) : null;
    const states = classifyMerchantAttention(
      {
        sourceType: row.source_type,
        currencyVerified: feed.currencyVerified,
        refreshMinutes: Number(row.refresh_minutes),
        lastRun,
        lastGoodAt,
      },
      now,
    );
    if (states.length === 0) continue;
    items.push({
      merchantId: Number(row.id),
      merchantName: row.name,
      merchantSlug: row.slug,
      states,
      lastRun,
      lastGoodAt,
      failuresSinceSuccess: Number(row.failures_since_success),
    });
  }
  return items.sort(
    (a, b) =>
      SEVERITY[a.states[0] as AttentionState] - SEVERITY[b.states[0] as AttentionState] ||
      a.merchantName.localeCompare(b.merchantName, "tr"),
  );
}
