/**
 * `/yonetim/arama/gorsel` (Faz 4): görsel arama yüklemelerinin durum izi.
 *
 * Görsel GÖSTERİLMEZ ve obje anahtarı dönmez (docs/kvkk.md: ham dosya en
 * fazla 30 gün tutulur, yalnızca embedding ve hash kalır). Kimin yüklediği
 * gösterilmez; yalnızca "üye / anonim". Hash, yalnızca kısaltılmış haliyle
 * (aynı görselin tekrarını görmek için) gösterilir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { clampPageSize, isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const IMAGE_UPLOAD_STATUSES = [
  "pending",
  "embedded",
  "rejected_not_product",
  "rejected_moderation",
] as const;
export type ImageUploadStatus = (typeof IMAGE_UPLOAD_STATUSES)[number];

export function isImageUploadStatus(value: unknown): value is ImageUploadStatus {
  return typeof value === "string" && (IMAGE_UPLOAD_STATUSES as readonly string[]).includes(value);
}

export interface ImageUploadRow {
  id: number;
  createdAt: Date;
  status: ImageUploadStatus;
  rejectionReason: string | null;
  hasFace: boolean;
  embedded: boolean;
  /** Ham dosya hâlâ depoda mı (anahtarın kendisi değil). */
  rawStored: boolean;
  purgeAfter: Date;
  /** `purge_after` geçmiş ama ham dosya silinmemiş: KVKK ihlali göstergesi. */
  purgeOverdue: boolean;
  member: boolean;
  hashPrefix: string;
}

type Row = {
  id: string;
  created_at: string;
  status: ImageUploadStatus;
  rejection_reason: string | null;
  has_face: boolean;
  embedded: boolean;
  raw_stored: boolean;
  purge_after: string;
  purge_overdue: boolean;
  member: boolean;
  hash_prefix: string;
};

export async function listImageUploads(
  db: Database,
  actor: AdminActor,
  filter: { status?: ImageUploadStatus; beforeId?: number; pageSize?: number } = {},
): Promise<{ rows: ImageUploadRow[]; nextBeforeId: number | null }> {
  assertCapability(actor, "diagnostics.read");
  const pageSize = clampPageSize(filter.pageSize);
  const conditions = [sql`true`];
  if (isImageUploadStatus(filter.status)) conditions.push(sql`status = ${filter.status}`);
  if (isPositiveId(filter.beforeId)) conditions.push(sql`id < ${filter.beforeId}`);

  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT id, created_at, status, left(rejection_reason, 200) AS rejection_reason, has_face,
             (embedding_id IS NOT NULL) AS embedded, (object_key IS NOT NULL) AS raw_stored,
             purge_after, (purge_after < now() AND object_key IS NOT NULL) AS purge_overdue,
             (user_id IS NOT NULL) AS member, left(image_hash, 12) AS hash_prefix
        FROM image_upload
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY id DESC
       LIMIT ${pageSize + 1}
    `);
    return result.rows;
  });

  const page = rows.slice(0, pageSize).map(
    (row): ImageUploadRow => ({
      id: Number(row.id),
      createdAt: new Date(row.created_at),
      status: row.status,
      rejectionReason: row.rejection_reason,
      hasFace: row.has_face,
      embedded: row.embedded,
      rawStored: row.raw_stored,
      purgeAfter: new Date(row.purge_after),
      purgeOverdue: row.purge_overdue,
      member: row.member,
      hashPrefix: row.hash_prefix,
    }),
  );
  const last = page[page.length - 1];
  return { rows: page, nextBeforeId: rows.length > pageSize && last ? last.id : null };
}

export interface ImageUploadSummary {
  byStatus7d: Record<string, number>;
  /** `api_usage.operation = 'visual_search'`, son 7 gün. */
  embedCalls7d: number;
  embedCacheHits7d: number;
  embedCostMicros7d: number;
  purgeOverdue: number;
}

export async function summarizeImageUploads(
  db: Database,
  actor: AdminActor,
): Promise<ImageUploadSummary> {
  assertCapability(actor, "diagnostics.read");
  return readOnly(db, 5_000, async (tx) => {
    const byStatus = await tx.execute<{ status: string; n: string }>(sql`
      SELECT status, count(*) AS n FROM image_upload
       WHERE created_at >= now() - interval '7 days' GROUP BY status
    `);
    const usage = await tx.execute<{ calls: string; hits: string; cost: string | null }>(sql`
      SELECT count(*) AS calls, count(*) FILTER (WHERE cache_hit) AS hits, sum(cost_micros) AS cost
        FROM api_usage
       WHERE operation = 'visual_search' AND created_at >= now() - interval '7 days'
    `);
    // `image_upload_purge_idx (purge_after) WHERE object_key IS NOT NULL`.
    const overdue = await tx.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM image_upload WHERE object_key IS NOT NULL AND purge_after < now()
    `);
    const u = usage.rows[0];
    return {
      byStatus7d: Object.fromEntries(byStatus.rows.map((row) => [row.status, Number(row.n)])),
      embedCalls7d: Number(u?.calls ?? 0),
      embedCacheHits7d: Number(u?.hits ?? 0),
      embedCostMicros7d: Number(u?.cost ?? 0),
      purgeOverdue: Number(overdue.rows[0]?.n ?? 0),
    };
  });
}
