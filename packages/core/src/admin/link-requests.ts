/**
 * `/yonetim/arama/link` (Faz 2): `link_resolution_request` tanı görünümü.
 *
 * Gösterilmeyenler: `session_id`, `user_id` (kimin aradığı), `url_raw`
 * (kullanıcının yapıştırdığı ham adres izleme/oturum token'ı taşıyabilir),
 * görsel adresi. Adres yalnızca ana makine + yol olarak, sorgu dizisi
 * olmadan gösterilir. `source` yalnızca izin listesindeki alanlarla döner.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { clampPageSize, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { redactText, safeUrl, urlHost } from "./redact.ts";

export const LINK_STATUSES = ["queued", "processing", "resolved", "failed"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** docs/schema.sql `link_resolution_request.error_code` kararlı kodları. */
export const LINK_ERROR_CODES = [
  "invalid_url",
  "blocked_destination",
  "robots_disallowed",
  "access_denied",
  "not_found",
  "rate_limited",
  "upstream_error",
  "http_error",
  "timeout",
  "fetch_failed",
  "too_many_redirects",
  "unsupported_content",
  "too_large",
  "no_product",
  "queue_unavailable",
  "unexpected",
] as const;

export function isLinkStatus(value: unknown): value is LinkStatus {
  return typeof value === "string" && (LINK_STATUSES as readonly string[]).includes(value);
}

export function isLinkErrorCode(value: unknown): value is (typeof LINK_ERROR_CODES)[number] {
  return typeof value === "string" && (LINK_ERROR_CODES as readonly string[]).includes(value);
}

const SOURCE_KEYS = [
  "title",
  "brand",
  "category",
  "gtin",
  "mpn",
  "sku",
  "price",
  "currency",
  "extraction_layer",
  "site",
  "image_status",
] as const;

/** Sayfa sinyallerinden yalnızca izinli, düz değerler; uzunluk sınırlı. */
export function linkSourceView(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const view: Record<string, string> = {};
  for (const key of SOURCE_KEYS) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      view[key] = String(value).slice(0, 200);
    }
  }
  return view;
}

export interface LinkRequestRow {
  id: string;
  createdAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  status: LinkStatus;
  errorCode: string | null;
  host: string | null;
  url: string | null;
  offerId: number | null;
  productSlug: string | null;
  hasImageEmbedding: boolean;
  source: Record<string, string>;
  errorText: string | null;
}

export interface LinkRequestFilter {
  status?: LinkStatus;
  errorCode?: string;
  /** Tam ana makine eşleşmesi (`www.ornek.com`). */
  host?: string;
  /** Önceki sayfanın son satırının imleci (`encodeLinkCursor`). */
  cursor?: string;
  pageSize?: number;
}

/**
 * İmleç: `created_at`'in veritabanındaki tam (mikrosaniyeli) metni + `id`.
 * JS `Date` mikrosaniyeyi taşıyamaz; metin taşır, satır atlanmaz.
 */
export function encodeLinkCursor(createdAtText: string, id: string): string {
  return `${createdAtText}|${id}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function decodeLinkCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("|");
  return at && id && TIMESTAMP.test(at) && UUID.test(id) ? { at, id } : null;
}

const HOST = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

type Row = {
  id: string;
  created_at: string;
  created_at_text: string;
  finished_at: string | null;
  status: LinkStatus;
  error_code: string | null;
  normalized_url: string | null;
  url_raw: string;
  offer_id: string | null;
  product_slug: string | null;
  has_image: boolean;
  source: unknown;
  error_text: string | null;
};

export async function listLinkRequests(
  db: Database,
  actor: AdminActor,
  filter: LinkRequestFilter = {},
): Promise<{ rows: LinkRequestRow[]; nextCursor: string | null }> {
  assertCapability(actor, "diagnostics.read");
  const pageSize = clampPageSize(filter.pageSize);
  const conditions = [sql`true`];
  if (isLinkStatus(filter.status)) conditions.push(sql`l.status = ${filter.status}`);
  if (isLinkErrorCode(filter.errorCode)) conditions.push(sql`l.error_code = ${filter.errorCode}`);
  if (filter.host && HOST.test(filter.host)) {
    conditions.push(
      sql`lower(substring(l.normalized_url from '^[a-z]+://([^/?#]+)')) = ${filter.host.toLowerCase()}`,
    );
  }
  const cursor = decodeLinkCursor(filter.cursor);
  if (cursor) {
    conditions.push(sql`(l.created_at, l.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
  }

  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT l.id, l.created_at,
             to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
             l.finished_at, l.status, l.error_code, l.normalized_url, l.url_raw,
             l.offer_id, p.slug AS product_slug, (l.image_embedding_id IS NOT NULL) AS has_image,
             l.source, left(l.error_text, 2000) AS error_text
        FROM link_resolution_request l
        LEFT JOIN offer o ON o.id = l.offer_id
        LEFT JOIN product p ON p.id = o.product_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT ${pageSize + 1}
    `);
    return result.rows;
  });

  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    rows: page.map((row): LinkRequestRow => {
      const createdAt = new Date(row.created_at);
      const finishedAt = row.finished_at ? new Date(row.finished_at) : null;
      const url = row.normalized_url ?? row.url_raw;
      return {
        id: row.id,
        createdAt,
        finishedAt,
        durationMs: finishedAt ? finishedAt.getTime() - createdAt.getTime() : null,
        status: row.status,
        errorCode: row.error_code,
        host: urlHost(url),
        url: safeUrl(url),
        offerId: row.offer_id === null ? null : Number(row.offer_id),
        productSlug: row.product_slug,
        hasImageEmbedding: row.has_image,
        source: linkSourceView(row.source),
        errorText: redactText(row.error_text),
      };
    }),
    nextCursor:
      rows.length > pageSize && last ? encodeLinkCursor(last.created_at_text, last.id) : null,
  };
}

export interface LinkRequestSummary {
  byStatus: Record<string, number>;
  byErrorCode: Record<string, number>;
  total: number;
}

/** Son 7 gün: duruma ve hata koduna göre. */
export async function summarizeLinkRequests(
  db: Database,
  actor: AdminActor,
): Promise<LinkRequestSummary> {
  assertCapability(actor, "diagnostics.read");
  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<{ status: string; error_code: string | null; n: string }>(sql`
      SELECT status, error_code, count(*) AS n
        FROM link_resolution_request
       WHERE created_at >= now() - interval '7 days'
       GROUP BY status, error_code
    `);
    return result.rows;
  });
  const summary: LinkRequestSummary = { byStatus: {}, byErrorCode: {}, total: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    summary.total += n;
    summary.byStatus[row.status] = (summary.byStatus[row.status] ?? 0) + n;
    if (row.error_code) {
      summary.byErrorCode[row.error_code] = (summary.byErrorCode[row.error_code] ?? 0) + n;
    }
  }
  return summary;
}
