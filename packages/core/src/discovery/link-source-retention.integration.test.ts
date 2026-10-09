/**
 * Link kaynağı görsel izi saklaması (karar 0090) — gerçek Postgres. Python
 * worker'ın yazdığı satır biçimi doğrudan SQL ile kurulur (ağ/model yok).
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getChatLinkView } from "../chat/link-view.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { findLinkSearchResults } from "./link-search.ts";
import { purgeExpiredLinkSourceEmbeddings } from "./link-source-retention.ts";

const run = `ls${Date.now().toString(36)}`;
const VECTOR = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
const SOURCE = {
  site: `${run}.test`,
  title: `Zq${run} sneaker`,
  brand: null,
  category: null,
  image_status: "embedded",
};

let db: Database;
const users: number[] = [];

async function owner<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return withOwnerClient(async (client) => (await client.query(text, params)).rows as T[]);
}

async function exists(table: "image_upload" | "embedding", id: number): Promise<boolean> {
  const rows = await owner(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return rows.length === 1;
}

async function requestEmbeddingId(requestId: string): Promise<number | null> {
  const [req] = await owner<{ image_embedding_id: string | null }>(
    "SELECT image_embedding_id FROM link_resolution_request WHERE id = $1",
    [requestId],
  );
  return req?.image_embedding_id == null ? null : Number(req.image_embedding_id);
}

interface LinkSource {
  uploadId: number;
  embeddingId: number;
  requestId: string;
  hash: string;
}

/** Worker'ın `reference_image._store` + `link_resolution_request` biçimi. */
async function linkSource(ageDays: number): Promise<LinkSource> {
  const hash = `h${run}${randomUUID().slice(0, 8)}`;
  const [up] = await owner<{ id: string }>(
    `INSERT INTO image_upload (session_id, image_hash, status, purge_after)
     VALUES ($1, $2, 'embedded', now() - ($3::int * interval '1 day') + interval '30 days')
     RETURNING id`,
    [`${run}-sess`, hash, ageDays],
  );
  const uploadId = Number(up?.id);
  const [emb] = await owner<{ id: string }>(
    `INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
     VALUES ('query', $1, 'image', $2, $3::vector) RETURNING id`,
    [uploadId, `m-${run}`, VECTOR],
  );
  const embeddingId = Number(emb?.id);
  await owner("UPDATE image_upload SET embedding_id = $2 WHERE id = $1", [uploadId, embeddingId]);
  const requestId = randomUUID();
  await owner(
    `INSERT INTO link_resolution_request
       (id, url_raw, session_id, status, source, image_embedding_id, finished_at)
     VALUES ($1, $2, $3, 'resolved', $4::jsonb, $5, now())`,
    [
      requestId,
      `https://${run}.test/u/${requestId}`,
      `${run}-sess`,
      JSON.stringify(SOURCE),
      embeddingId,
    ],
  );
  return { uploadId, embeddingId, requestId, hash };
}

async function chatReferencing(requestId: string, lastMessageDaysAgo: number): Promise<string> {
  const [u] = await owner<{ id: string }>("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
    `${run}-${randomUUID().slice(0, 8)}@test.invalid`,
  ]);
  users.push(Number(u?.id));
  const [c] = await owner<{ id: string }>(
    `INSERT INTO conversation (user_id, title, last_message_at, message_count)
     VALUES ($1, 'link', now() - ($2::int * interval '1 day'), 1) RETURNING id`,
    [Number(u?.id), lastMessageDaysAgo],
  );
  await owner(
    `INSERT INTO chat_message (conversation_id, seq, role, kind, content, payload)
     VALUES ($1, 1, 'assistant', 'notice', 'link', $2::jsonb)`,
    [c?.id, JSON.stringify({ link: { requestId, errorCode: null } })],
  );
  return String(c?.id);
}

beforeAll(() => {
  db = getTestDb();
});

afterAll(async () => {
  await owner("DELETE FROM link_resolution_request WHERE session_id = $1", [`${run}-sess`]);
  await owner("DELETE FROM image_upload WHERE session_id LIKE $1", [`${run}%`]);
  await owner("DELETE FROM embedding WHERE model_version = $1", [`m-${run}`]);
  if (users.length) await owner("DELETE FROM app_user WHERE id = ANY($1::bigint[])", [users]);
});

describe("purgeExpiredLinkSourceEmbeddings", () => {
  it("süresi dolmuş link kaynağını siler, bağı NULL yapar; metne düşen okumalar hata vermez", async () => {
    const s = await linkSource(40);
    const before = await getChatLinkView(db, { requestId: s.requestId, errorCode: null });
    expect(before.state === "resolved" && before.linkState.imageEmbeddingId).toBe(s.embeddingId);

    const result = await purgeExpiredLinkSourceEmbeddings(db);
    expect(result.embeddings).toBeGreaterThanOrEqual(1);
    expect(result.uploads).toBe(result.embeddings);
    expect(await exists("image_upload", s.uploadId)).toBe(false);
    expect(await exists("embedding", s.embeddingId)).toBe(false);
    expect(await requestEmbeddingId(s.requestId)).toBeNull();

    const after = await getChatLinkView(db, { requestId: s.requestId, errorCode: null });
    expect(after.state).toBe("resolved");
    if (after.state !== "resolved") return;
    expect(after.linkState.imageEmbeddingId).toBeNull();
    await expect(findLinkSearchResults(db, after.linkState)).resolves.toBeDefined();
  });

  it("süresi dolmamış kaynak kalır", async () => {
    const s = await linkSource(5);
    await purgeExpiredLinkSourceEmbeddings(db);
    expect(await exists("image_upload", s.uploadId)).toBe(true);
    expect(await exists("embedding", s.embeddingId)).toBe(true);
  });

  it("aktif sohbetin andığı kaynak kalır; sohbet silinmiş ya da süresi dolmuşsa silinir", async () => {
    const active = await linkSource(40);
    const conv = await chatReferencing(active.requestId, 10);
    const stale = await linkSource(120);
    await chatReferencing(stale.requestId, 100);
    const deleted = await linkSource(40);
    const gone = await chatReferencing(deleted.requestId, 1);
    await owner("DELETE FROM conversation WHERE id = $1", [gone]);

    await purgeExpiredLinkSourceEmbeddings(db);
    expect(await exists("embedding", active.embeddingId)).toBe(true);
    expect(await exists("image_upload", active.uploadId)).toBe(true);
    expect(await requestEmbeddingId(active.requestId)).toBe(active.embeddingId);
    expect(await exists("embedding", stale.embeddingId)).toBe(false);
    expect(await exists("embedding", deleted.embeddingId)).toBe(false);

    // Sohbet 90 günü aşınca (cron sohbeti silmeden önce bile) kaynak da gider.
    await owner(
      "UPDATE conversation SET last_message_at = now() - interval '91 days' WHERE id = $1",
      [conv],
    );
    await purgeExpiredLinkSourceEmbeddings(db);
    expect(await exists("embedding", active.embeddingId)).toBe(false);
  });

  it("kullanıcı yüklemesi ve paylaşılan hash embedding'i kalır", async () => {
    // Kullanıcı yüklemesi: link isteğiyle ilişkisiz, süresi dolmuş.
    const [uu] = await owner<{ id: string }>(
      `INSERT INTO image_upload (session_id, image_hash, status, purge_after)
       VALUES ($1, $2, 'embedded', now() - interval '1 day') RETURNING id`,
      [`${run}-user`, `u${run}`],
    );
    const userUpload = Number(uu?.id);
    const [ue] = await owner<{ id: string }>(
      `INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
       VALUES ('query', $1, 'image', $2, $3::vector) RETURNING id`,
      [userUpload, `m-${run}`, VECTOR],
    );
    await owner("UPDATE image_upload SET embedding_id = $2 WHERE id = $1", [
      userUpload,
      Number(ue?.id),
    ]);

    // Link kaynağı embedding'ini hash önbelleğinden paylaşan kullanıcı yüklemesi.
    const shared = await linkSource(40);
    const [su] = await owner<{ id: string }>(
      `INSERT INTO image_upload (session_id, image_hash, status, embedding_id, purge_after)
       VALUES ($1, $2, 'embedded', $3, now() + interval '20 days') RETURNING id`,
      [`${run}-user`, shared.hash, shared.embeddingId],
    );

    await purgeExpiredLinkSourceEmbeddings(db);
    expect(await exists("image_upload", userUpload)).toBe(true);
    expect(await exists("embedding", Number(ue?.id))).toBe(true);
    expect(await exists("image_upload", Number(su?.id))).toBe(true);
    expect(await exists("embedding", shared.embeddingId)).toBe(true);
    expect(await exists("image_upload", shared.uploadId)).toBe(true);
    expect(await requestEmbeddingId(shared.requestId)).toBe(shared.embeddingId);
  });

  it("idempotent ve parti sınırlı", async () => {
    const made = await Promise.all([1, 2, 3, 4, 5].map(() => linkSource(45)));
    const first = await purgeExpiredLinkSourceEmbeddings(db, new Date(), {
      batchSize: 2,
      maxBatches: 1,
    });
    expect(first).toEqual({ embeddings: 2, uploads: 2, detached: 2, truncated: true });

    await purgeExpiredLinkSourceEmbeddings(db);
    for (const m of made) expect(await exists("embedding", m.embeddingId)).toBe(false);
    const again = await purgeExpiredLinkSourceEmbeddings(db);
    expect(again).toEqual({ embeddings: 0, uploads: 0, detached: 0, truncated: false });
  });
});
