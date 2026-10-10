/**
 * Fiyatsız link kaynaklarının görsel izi için saklama temizliği (karar 0090).
 *
 * Python worker (`services/ingest/collect/link/reference_image.py`) her link
 * isteği için KENDİ `image_upload` + `embedding(target_type='query')` çiftini
 * yazar ve `link_resolution_request.image_embedding_id`'yi buna bağlar. Ham
 * dosya hiç saklanmaz; ama 30 günlük `purge_after` sözleşmesi bu satırları
 * silmiyordu (yalnızca `object_key`'i boşaltıyordu). Bu iş o boşluğu kapatır.
 *
 * Silinir YALNIZCA şunların hepsi doğruysa:
 * - `image_upload.purge_after < now` (mevcut 30 gün sözleşmesi);
 * - embedding bir link isteğine bağlı (`link_resolution_request.image_embedding_id`);
 * - başka hiçbir `image_upload.embedding_id` o embedding'i kullanmıyor
 *   (kullanıcı yüklemesi aynı hash'i önbellekten paylaşmış olabilir;
 *   `embed-uploaded-image.ts` `findCachedEmbedding`);
 * - o isteği AKTİF bir sohbet (son mesajı 90 günden genç) `payload.link.requestId`
 *   ile anmıyor. Sohbet saklaması (90 gün) 30 günden uzundur; takip/iyileştirme
 *   turu kaynak vektörü ister.
 *
 * Silmeden önce `image_embedding_id` NULL'a çekilir: `findLinkSearchResults`
 * ve `getChatLinkView` bunu zaten "görsel sinyali yok, arama metinle yürür"
 * diye okur. Süresi dolmuş sohbetin ya da sohbetsiz isteğin görsel sinyalini
 * yitirmesi KABUL EDİLEN davranıştır.
 *
 * Kullanıcı yüklemelerinin (link isteğiyle ilişkisiz `image_upload`) ömrüne
 * dokunulmaz. Şema/migration yok. Yalnızca sayı döner (içerik yok).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { CHAT_RETENTION_DAYS } from "../chat/config.ts";

export interface LinkSourceRetentionResult {
  /** Silinen `embedding` satırı. */
  embeddings: number;
  /** Silinen `image_upload` satırı. */
  uploads: number;
  /** `image_embedding_id`'si NULL'a çekilen `link_resolution_request` satırı. */
  detached: number;
  truncated: boolean;
}

function idList(ids: number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

export async function purgeExpiredLinkSourceEmbeddings(
  db: Database,
  now: Date = new Date(),
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<LinkSourceRetentionResult> {
  const batchSize = options.batchSize ?? 500;
  const maxBatches = options.maxBatches ?? 20;
  const chatCutoff = new Date(now.getTime() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const total: LinkSourceRetentionResult = {
    embeddings: 0,
    uploads: 0,
    detached: 0,
    truncated: false,
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const picked = await db.transaction(async (tx) => {
      // Aday embedding'ler kilitlenir (FOR UPDATE): aynı anda önbellekten bu
      // embedding'i paylaşmaya çalışan bir yükleme FK kilidinde bekler, sonra
      // kısıt hatası alır; sessiz kırık bağ oluşmaz.
      const candidates = await tx.execute(sql`
        WITH active_refs AS (
          SELECT DISTINCT m.payload->'link'->>'requestId' AS request_id
            FROM chat_message m
            JOIN conversation c ON c.id = m.conversation_id
           WHERE c.last_message_at >= ${chatCutoff.toISOString()}::timestamptz
             AND m.payload->'link'->>'requestId' IS NOT NULL
        )
        SELECT u.id AS upload_id, e.id AS embedding_id
          FROM image_upload u
          JOIN embedding e
            ON e.id = u.embedding_id AND e.target_type = 'query' AND e.target_id = u.id
         WHERE u.purge_after < ${now.toISOString()}::timestamptz
           AND EXISTS (
             SELECT 1 FROM link_resolution_request r WHERE r.image_embedding_id = e.id)
           AND NOT EXISTS (
             SELECT 1 FROM image_upload o WHERE o.embedding_id = e.id AND o.id <> u.id)
           AND NOT EXISTS (
             SELECT 1 FROM link_resolution_request r
               JOIN active_refs a ON a.request_id = r.id::text
              WHERE r.image_embedding_id = e.id)
         ORDER BY u.id
         LIMIT ${batchSize}
           FOR UPDATE OF e
      `);
      const rows = candidates.rows as {
        upload_id: string | number;
        embedding_id: string | number;
      }[];
      if (rows.length === 0) return 0;
      const uploadIds = rows.map((r) => Number(r.upload_id));
      const embeddingIds = rows.map((r) => Number(r.embedding_id));

      const detached = await tx.execute(sql`
        UPDATE link_resolution_request SET image_embedding_id = NULL
         WHERE image_embedding_id IN (${idList(embeddingIds)})
      `);
      const uploads = await tx.execute(sql`
        DELETE FROM image_upload WHERE id IN (${idList(uploadIds)})
      `);
      const embeddings = await tx.execute(sql`
        DELETE FROM embedding WHERE id IN (${idList(embeddingIds)})
      `);
      total.detached += detached.rowCount ?? 0;
      total.uploads += uploads.rowCount ?? 0;
      total.embeddings += embeddings.rowCount ?? 0;
      return rows.length;
    });
    if (picked < batchSize) return total;
  }
  total.truncated = true;
  return total;
}

/** Günlük temizlikte diğer saklama işlerinden yalıtılır; hata yalnızca SQL koduyla loglanır. */
export async function purgeExpiredLinkSourceEmbeddingsSafely(
  db: Database,
  now: Date = new Date(),
): Promise<LinkSourceRetentionResult & { failed: string | null }> {
  try {
    return { ...(await purgeExpiredLinkSourceEmbeddings(db, now)), failed: null };
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
      (error as { code?: string })?.code ??
      "error";
    console.warn(
      "[link-source] retention purge failed",
      error instanceof Error ? error.name : "unknown",
      code,
    );
    return {
      embeddings: 0,
      uploads: 0,
      detached: 0,
      truncated: false,
      failed: /^[0-9A-Z]{5}$/.test(code) ? code : "error",
    };
  }
}
