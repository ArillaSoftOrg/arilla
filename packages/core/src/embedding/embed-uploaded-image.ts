/**
 * `EmbeddingService` — `docs/architecture.md` §2, `CLAUDE.md` kural 1'in tek
 * istisnası. Kullanıcının yüklediği görselin embedding'i istek yolunda,
 * `image_hash` ile cache'lenerek üretilir.
 *
 * Yüz tespiti ve moderasyon henüz yok: `docs/decisions/0022`.
 */

import { createHash } from "node:crypto";
import { apiUsage, type Database, embedding, imageUpload } from "@arilla/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { type EmbeddingClient, getEmbeddingClient } from "./client.ts";

const PURGE_AFTER_DAYS = 30;

export class EmbeddingProviderError extends Error {
  constructor(cause: unknown) {
    super(`görsel embedding üretilemedi: ${cause instanceof Error ? cause.message : cause}`);
    this.name = "EmbeddingProviderError";
    this.cause = cause;
  }
}

export interface EmbedUploadedImageInput {
  bytes: Buffer;
  mimeType: string;
  sessionId: string;
  userId: number | null;
}

export interface EmbedUploadedImageResult {
  imageUploadId: number;
  embeddingId: number;
  vector: number[];
  cacheHit: boolean;
}

export function hashImageBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `services/ingest/db/usage.py`'deki formülün aynısı - iki yerde de aynı
 * `EMBEDDING_COST_MICROS_PER_1K_TOKENS` (varsayılan 0, `docs/decisions/0015`
 * kapanmadı) okunur, aksi halde iki tarafın maliyet raporu tutarsız olur.
 */
function costMicros(tokens: number): number {
  const perThousand = Number(process.env.EMBEDDING_COST_MICROS_PER_1K_TOKENS ?? 0);
  return Math.round((tokens * perThousand) / 1000);
}

/**
 * Yükleme kaydı her zaman oluşturulur (KVKK izlenebilirliği ve
 * `purge_after`), ama sağlayıcı çağrısı yalnızca aynı hash'te önceden
 * embed edilmiş bir satır yoksa yapılır.
 *
 * Varsayılan `client` argümanı gövdeden önce çözülür: sağlayıcı
 * yapılandırılmamışsa `EmbeddingUnavailableError` hiçbir satır yazılmadan
 * atılır. Sağlayıcı çağrısı başarısız olursa `image_upload` `pending` kalır,
 * `embedding` ve `api_usage` yazılmaz — başarılı embedding iddia eden kayıt
 * yalnızca gerçek bir vektör döndüğünde oluşur.
 */
export async function embedUploadedImage(
  db: Database,
  input: EmbedUploadedImageInput,
  client: EmbeddingClient = getEmbeddingClient(),
): Promise<EmbedUploadedImageResult> {
  const imageHash = hashImageBytes(input.bytes);
  const purgeAfter = new Date(Date.now() + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const [created] = await db
    .insert(imageUpload)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      imageHash,
      hasFace: false,
      purgeAfter,
    })
    .returning({ id: imageUpload.id });
  if (!created) {
    throw new Error("image_upload insert boş sonuç döndürdü");
  }

  const cached = await findCachedEmbedding(db, imageHash);
  if (cached) {
    await db
      .update(imageUpload)
      .set({ status: "embedded", embeddingId: cached.id })
      .where(eq(imageUpload.id, created.id));
    await db.insert(apiUsage).values({
      sessionId: input.sessionId,
      userId: input.userId,
      operation: "visual_search",
      modelVersion: null,
      units: 0,
      cacheHit: true,
    });
    return {
      imageUploadId: created.id,
      embeddingId: cached.id,
      vector: cached.vector,
      cacheHit: true,
    };
  }

  const dataUrl = `data:${input.mimeType};base64,${input.bytes.toString("base64")}`;
  let result: Awaited<ReturnType<EmbeddingClient["embedImage"]>>;
  try {
    result = await client.embedImage(dataUrl);
  } catch (error) {
    throw new EmbeddingProviderError(error);
  }

  const [embeddingRow] = await db
    .insert(embedding)
    .values({
      targetType: "query",
      targetId: created.id,
      kind: "image",
      modelVersion: result.modelVersion,
      vector: result.vector,
    })
    .returning({ id: embedding.id });
  if (!embeddingRow) {
    throw new Error("embedding insert boş sonuç döndürdü");
  }

  await db
    .update(imageUpload)
    .set({ status: "embedded", embeddingId: embeddingRow.id })
    .where(eq(imageUpload.id, created.id));

  await db.insert(apiUsage).values({
    sessionId: input.sessionId,
    userId: input.userId,
    operation: "visual_search",
    modelVersion: result.modelVersion,
    units: result.tokens,
    costMicros: costMicros(result.tokens),
    cacheHit: false,
  });

  return {
    imageUploadId: created.id,
    embeddingId: embeddingRow.id,
    vector: result.vector,
    cacheHit: false,
  };
}

export interface UploadedImageEmbedding {
  vector: number[];
  modelVersion: string;
}

/**
 * `/ara/gorsel` — `imageUploadId`'nin bu oturuma/kullanıcıya ait ve embed
 * edilmiş olduğunu doğrular, sonra arama için vektörü döner. `apps/web`'in
 * kendisi drizzle sorgusu yazmaz (`CLAUDE.md` kural 6).
 */
export async function getUploadedImageEmbeddingForSearch(
  db: Database,
  input: { imageUploadId: number; sessionId: string | null; userId: number | null },
): Promise<UploadedImageEmbedding | null> {
  const uploadRows = await db
    .select({
      userId: imageUpload.userId,
      sessionId: imageUpload.sessionId,
      status: imageUpload.status,
      embeddingId: imageUpload.embeddingId,
    })
    .from(imageUpload)
    .where(eq(imageUpload.id, input.imageUploadId))
    .limit(1);
  const upload = uploadRows[0];
  if (!upload) return null;

  // Baskasinin yukledigi gorselin sonucuna dogrudan id ile erisilemez.
  const owns =
    (input.userId !== null && upload.userId === input.userId) ||
    (input.sessionId !== null && upload.sessionId === input.sessionId);
  if (!owns) return null;
  if (upload.status !== "embedded" || upload.embeddingId === null) return null;

  const rows = await db
    .select({ vector: embedding.vector, modelVersion: embedding.modelVersion })
    .from(embedding)
    .where(and(eq(embedding.id, upload.embeddingId), eq(embedding.kind, "image")))
    .limit(1);
  return rows[0] ?? null;
}

async function findCachedEmbedding(
  db: Database,
  imageHash: string,
): Promise<{ id: number; vector: number[] } | undefined> {
  const previous = await db
    .select({ embeddingId: imageUpload.embeddingId })
    .from(imageUpload)
    .where(
      and(
        eq(imageUpload.imageHash, imageHash),
        eq(imageUpload.status, "embedded"),
        isNotNull(imageUpload.embeddingId),
      ),
    )
    .orderBy(desc(imageUpload.createdAt))
    .limit(1);

  const embeddingId = previous[0]?.embeddingId;
  if (!embeddingId) return undefined;

  const rows = await db
    .select({ id: embedding.id, vector: embedding.vector })
    .from(embedding)
    .where(eq(embedding.id, embeddingId))
    .limit(1);
  return rows[0];
}
