/**
 * `/yonetim/ingest` ve mağaza ayrıntısındaki koşu geçmişi (Faz 2). Salt
 * okunur: "şimdi çalıştır" ya da yeniden deneme YOK (docs/decisions/0039) —
 * toplama işleri CLI/zamanlayıcıdan çalışır, bu ekran yalnızca izini okur.
 *
 * `error_text` Python istisna metnidir; feed adresini sorgu dizisiyle
 * içerebilir. Gösterilmeden önce adresler kırpılır (`redactText`).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { clampPageSize, isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import type { IngestStatus } from "./merchants.ts";
import { redactText } from "./redact.ts";

export const INGEST_STATUSES: readonly IngestStatus[] = ["running", "success", "partial", "failed"];

export function isIngestStatus(value: unknown): value is IngestStatus {
  return typeof value === "string" && (INGEST_STATUSES as readonly string[]).includes(value);
}

export interface IngestRunRow {
  id: number;
  merchantId: number;
  merchantSlug: string;
  merchantName: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  status: IngestStatus;
  offersSeen: number;
  offersCreated: number;
  offersUpdated: number;
  pricePointsWritten: number;
  /** `collect/gate.py` reddi: `error_text` = `refused:<kod>...`. */
  refusedCode: string | null;
  errorText: string | null;
}

export interface IngestRunFilter {
  merchantId?: number;
  status?: IngestStatus;
  /** Önceki sayfanın son `id`'si. */
  beforeId?: number;
  pageSize?: number;
}

export function parseRefusedCode(errorText: string | null): string | null {
  const match = errorText ? /^refused:([a-z_]{1,60})/.exec(errorText) : null;
  return match?.[1] ?? null;
}

type Row = {
  id: string;
  merchant_id: string;
  slug: string;
  name: string;
  started_at: string;
  finished_at: string | null;
  status: IngestStatus;
  offers_seen: number;
  offers_created: number;
  offers_updated: number;
  price_points_written: number;
  error_text: string | null;
};

export async function listIngestRuns(
  db: Database,
  actor: AdminActor,
  filter: IngestRunFilter = {},
): Promise<{ rows: IngestRunRow[]; nextBeforeId: number | null }> {
  assertCapability(actor, "ingest.read");
  const pageSize = clampPageSize(filter.pageSize);
  const conditions = [sql`true`];
  if (isPositiveId(filter.merchantId)) conditions.push(sql`r.merchant_id = ${filter.merchantId}`);
  if (isIngestStatus(filter.status)) conditions.push(sql`r.status = ${filter.status}`);
  if (isPositiveId(filter.beforeId)) conditions.push(sql`r.id < ${filter.beforeId}`);

  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT r.id, r.merchant_id, m.slug, m.name, r.started_at, r.finished_at, r.status,
             r.offers_seen, r.offers_created, r.offers_updated, r.price_points_written,
             left(r.error_text, 4000) AS error_text
        FROM ingest_run r JOIN merchant m ON m.id = r.merchant_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY r.id DESC
       LIMIT ${pageSize + 1}
    `);
    return result.rows;
  });

  const page = rows.slice(0, pageSize).map((row): IngestRunRow => {
    const startedAt = new Date(row.started_at);
    const finishedAt = row.finished_at ? new Date(row.finished_at) : null;
    return {
      id: Number(row.id),
      merchantId: Number(row.merchant_id),
      merchantSlug: row.slug,
      merchantName: row.name,
      startedAt,
      finishedAt,
      durationMs: finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
      status: row.status,
      offersSeen: row.offers_seen,
      offersCreated: row.offers_created,
      offersUpdated: row.offers_updated,
      pricePointsWritten: row.price_points_written,
      refusedCode: parseRefusedCode(row.error_text),
      errorText: redactText(row.error_text),
    };
  });
  const last = page[page.length - 1];
  return { rows: page, nextBeforeId: rows.length > pageSize && last ? last.id : null };
}
