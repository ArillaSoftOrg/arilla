/**
 * `/yonetim/ingest/beslemeler` (karar 0113): besleme kaynaklari, senkronizasyon
 * durumu, son basarili aktarim, aktarilan/degisen/hatali kayit sayilari, hata
 * kayitlari ve fiyat dogrulama durumu. SALT OKUNUR: tetikleme, yeniden deneme
 * ya da etkinlestirme yok (CLI'dan; karar 0039 ile ayni ilke).
 *
 * Gizlilik/guvenlik: besleme adresi yalnizca kimlik parametreleri silinmis haliyle
 * (`source_url_redacted`) vardir; hata ayrintisi `redactText`'ten gecer; hata
 * kaydinin ham `payload`'i bu ekrana gelmez.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { approximateTry, type FxQuote, latestFxQuote } from "../pricing/fx.ts";
import { isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { redactText } from "./redact.ts";

export interface FeedSourceRow {
  id: number;
  network: string;
  externalId: string;
  name: string | null;
  programName: string | null;
  status: string;
  merchantSlug: string | null;
  merchantActive: boolean | null;
  currency: string | null;
  sourceUrl: string | null;
  sourceUpdatedAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  schemaChangedAt: Date | null;
  snapshot: {
    status: string;
    rejectReason: string | null;
    records: number | null;
    rejected: number;
    completedAt: Date | null;
  } | null;
  run: {
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
    seen: number;
    created: number;
    changed: number;
    unchanged: number;
    deactivated: number;
    rejected: number;
  } | null;
  memberOffers: number;
  openErrors: number;
}

export interface PriceVerificationSummary {
  /** Son 7 gun, sonuca gore. */
  byResult: Record<string, number>;
  pending: number;
  unsupported: number;
  failed: number;
  lastVerifiedAt: Date | null;
}

export interface FeedsOverview {
  feeds: FeedSourceRow[];
  verification: PriceVerificationSummary;
  usdQuote: FxQuote | null;
  /** Ornek: 10 USD'nin yaklasik TRY karsiligi (kur yoksa null). */
  usdExample: number | null;
}

type FeedDbRow = {
  id: string;
  network: string;
  external_id: string;
  name: string | null;
  program_name: string | null;
  status: string;
  merchant_slug: string | null;
  merchant_active: boolean | null;
  currency: string | null;
  source_url_redacted: string | null;
  source_updated_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  schema_changed_at: string | null;
  snap_status: string | null;
  snap_reason: string | null;
  snap_records: number | null;
  snap_rejected: number | null;
  snap_completed: string | null;
  run_status: string | null;
  run_started: string | null;
  run_finished: string | null;
  run_seen: number | null;
  run_created: number | null;
  run_changed: number | null;
  run_unchanged: number | null;
  run_deactivated: number | null;
  run_rejected: number | null;
  member_offers: string;
  open_errors: string;
};

const date = (value: string | null): Date | null => (value ? new Date(value) : null);

export async function feedsOverview(db: Database, actor: AdminActor): Promise<FeedsOverview> {
  assertCapability(actor, "ingest.read");
  const { rows, verification } = await readOnly(db, 5_000, async (tx) => {
    const feeds = await tx.execute<FeedDbRow>(sql`
      SELECT f.id, f.network, f.external_id, f.name, f.program_name, f.status,
             m.slug AS merchant_slug, m.is_active AS merchant_active, f.currency,
             f.source_url_redacted, f.source_updated_at, f.last_success_at, f.last_error_code,
             f.schema_changed_at,
             s.status AS snap_status, s.reject_reason AS snap_reason, s.record_count AS snap_records,
             s.rejected_count AS snap_rejected, s.completed_at AS snap_completed,
             r.status AS run_status, r.started_at AS run_started, r.finished_at AS run_finished,
             r.offers_seen AS run_seen, r.offers_created AS run_created,
             r.offers_updated AS run_changed, r.offers_unchanged AS run_unchanged,
             r.offers_deactivated AS run_deactivated, r.records_rejected AS run_rejected,
             (SELECT count(*) FROM feed_source_offer fo WHERE fo.feed_source_id = f.id) AS member_offers,
             (SELECT count(*) FROM ingest_error e
               WHERE e.feed_source_id = f.id AND e.status IN ('open', 'retrying')) AS open_errors
        FROM feed_source f
        LEFT JOIN merchant m ON m.id = f.merchant_id
        LEFT JOIN LATERAL (
             SELECT * FROM source_snapshot ss WHERE ss.feed_source_id = f.id
              ORDER BY ss.id DESC LIMIT 1) s ON true
        LEFT JOIN LATERAL (
             SELECT * FROM ingest_run ir WHERE ir.feed_source_id = f.id
              ORDER BY ir.id DESC LIMIT 1) r ON true
       ORDER BY (f.status = 'active') DESC, f.network, f.id
       LIMIT 500
    `);
    const summary = await tx.execute<{ result: string; n: string; last: string | null }>(sql`
      SELECT result, count(*) AS n, max(verified_at) AS last FROM price_verification
       WHERE verified_at > now() - interval '7 days' GROUP BY result
    `);
    const queue = await tx.execute<{ status: string; n: string }>(sql`
      SELECT status, count(*) AS n FROM price_verification_request
       WHERE status IN ('pending', 'running', 'unsupported', 'failed') GROUP BY status
    `);
    return { rows: feeds.rows, verification: { summary: summary.rows, queue: queue.rows } };
  });

  const byResult: Record<string, number> = {};
  let lastVerifiedAt: Date | null = null;
  for (const row of verification.summary) {
    byResult[row.result] = Number(row.n);
    const last = date(row.last);
    if (last && (!lastVerifiedAt || last > lastVerifiedAt)) lastVerifiedAt = last;
  }
  const queue = Object.fromEntries(verification.queue.map((r) => [r.status, Number(r.n)]));
  const usdQuote = await latestFxQuote(db, "USD");

  return {
    feeds: rows.map(
      (row): FeedSourceRow => ({
        id: Number(row.id),
        network: row.network,
        externalId: row.external_id,
        name: row.name,
        programName: row.program_name,
        status: row.status,
        merchantSlug: row.merchant_slug,
        merchantActive: row.merchant_active,
        currency: row.currency,
        sourceUrl: row.source_url_redacted,
        sourceUpdatedAt: date(row.source_updated_at),
        lastSuccessAt: date(row.last_success_at),
        lastErrorCode: row.last_error_code,
        schemaChangedAt: date(row.schema_changed_at),
        snapshot: row.snap_status
          ? {
              status: row.snap_status,
              rejectReason: row.snap_reason,
              records: row.snap_records,
              rejected: row.snap_rejected ?? 0,
              completedAt: date(row.snap_completed),
            }
          : null,
        run:
          row.run_status && row.run_started
            ? {
                status: row.run_status,
                startedAt: new Date(row.run_started),
                finishedAt: date(row.run_finished),
                seen: row.run_seen ?? 0,
                created: row.run_created ?? 0,
                changed: row.run_changed ?? 0,
                unchanged: row.run_unchanged ?? 0,
                deactivated: row.run_deactivated ?? 0,
                rejected: row.run_rejected ?? 0,
              }
            : null,
        memberOffers: Number(row.member_offers),
        openErrors: Number(row.open_errors),
      }),
    ),
    verification: {
      byResult,
      pending: (queue.pending ?? 0) + (queue.running ?? 0),
      unsupported: queue.unsupported ?? 0,
      failed: queue.failed ?? 0,
      lastVerifiedAt,
    },
    usdQuote,
    usdExample: approximateTry(1000, "USD", usdQuote)?.approxTryMinor ?? null,
  };
}

export interface FeedErrorRow {
  id: number;
  createdAt: Date;
  errorCode: string;
  recordRef: string | null;
  externalId: string | null;
  detail: string | null;
  status: string;
}

/** Bir beslemenin son hata kayitlari (ham payload YOK). */
export async function listFeedErrors(
  db: Database,
  actor: AdminActor,
  feedSourceId: number,
): Promise<FeedErrorRow[]> {
  assertCapability(actor, "ingest.read");
  if (!isPositiveId(feedSourceId)) return [];
  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<{
      id: string;
      created_at: string;
      error_code: string;
      record_ref: string | null;
      external_id: string | null;
      detail: string | null;
      status: string;
    }>(sql`
      SELECT id, created_at, error_code, record_ref, external_id, left(detail, 300) AS detail, status
        FROM ingest_error WHERE feed_source_id = ${feedSourceId}
       ORDER BY id DESC LIMIT 100
    `);
    return result.rows;
  });
  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: new Date(row.created_at),
    errorCode: row.error_code,
    recordRef: row.record_ref,
    externalId: row.external_id,
    detail: redactText(row.detail),
    status: row.status,
  }));
}
