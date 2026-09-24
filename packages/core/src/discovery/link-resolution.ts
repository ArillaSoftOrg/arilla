/**
 * Kök catch-all'ın kuyruğa alma ve poll edilecek durum tarafı.
 * `docs/schema.sql` "Kök catch-all'ın tekil link çözümleme durumu" notu:
 * Python worker aynı `collect.link.resolver.resolve_url`'i bu kuyruktan
 * tetikler (`services/ingest/collect/link/__main__.py --worker`).
 *
 * Kuyruk anahtarı iki tarafta da AYNI OLMALI - burada değişirse Python
 * tarafında da değişmeli (elle senkronize edilir, paylaşılan bir sabit
 * yok çünkü diller arasında import edilemez).
 */
import { type Database, linkResolutionRequest, offer, product } from "@arilla/db";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { getRedis, RedisUnavailableError } from "../redis/client.ts";
import { normalizeUrl } from "./normalize-url.ts";

export const LINK_RESOLUTION_QUEUE_KEY = "queue:link_resolution";

/** Aynı sayfanın kısa sürede tekrar yüklenmesi (bekleme ekranı) ikinci bir iş üretmemeli. */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export interface EnqueueLinkResolutionInput {
  urlRaw: string;
  sessionId: string;
  userId: number | null;
}

export async function enqueueLinkResolution(
  db: Database,
  input: EnqueueLinkResolutionInput,
): Promise<{ requestId: string }> {
  // Yalnızca gerçek bir URL kuyruğa girer - normalize burada da çalışır ki
  // Python tarafına geçersiz bir şey gitmesin.
  normalizeUrl(input.urlRaw);

  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const existing = await db
    .select({ id: linkResolutionRequest.id })
    .from(linkResolutionRequest)
    .where(
      and(
        eq(linkResolutionRequest.urlRaw, input.urlRaw),
        eq(linkResolutionRequest.sessionId, input.sessionId),
        inArray(linkResolutionRequest.status, ["queued", "processing"]),
        gt(linkResolutionRequest.createdAt, since),
      ),
    )
    .orderBy(desc(linkResolutionRequest.createdAt))
    .limit(1);

  if (existing[0]) {
    return { requestId: existing[0].id };
  }

  const [created] = await db
    .insert(linkResolutionRequest)
    .values({ urlRaw: input.urlRaw, sessionId: input.sessionId, userId: input.userId })
    .returning({ id: linkResolutionRequest.id });
  if (!created) {
    throw new Error("link_resolution_request insert boş sonuç döndürdü");
  }

  try {
    await getRedis().lpush(LINK_RESOLUTION_QUEUE_KEY, JSON.stringify({ request_id: created.id }));
  } catch (error) {
    // Satır 'queued' kalırsa hiçbir worker onu almaz ve dedupe penceresi
    // boyunca aynı sayfa yeniden yüklemesi bu ölü satıra bağlanırdı. Satır
    // 'failed' işaretlenir (best-effort) ve hata çağırana iletilir.
    await db
      .update(linkResolutionRequest)
      .set({ status: "failed", errorText: "queue_unavailable", finishedAt: new Date() })
      .where(eq(linkResolutionRequest.id, created.id))
      .catch(() => undefined);
    throw new RedisUnavailableError("link cozumleme kuyrugu", { cause: error });
  }

  return { requestId: created.id };
}

export interface LinkResolutionStatus {
  status: "queued" | "processing" | "resolved" | "failed";
  productSlug: string | null;
  errorText: string | null;
}

export async function getLinkResolutionStatus(
  db: Database,
  requestId: string,
): Promise<LinkResolutionStatus | null> {
  const rows = await db
    .select({
      status: linkResolutionRequest.status,
      errorText: linkResolutionRequest.errorText,
      slug: product.slug,
    })
    .from(linkResolutionRequest)
    .leftJoin(offer, eq(offer.id, linkResolutionRequest.offerId))
    .leftJoin(product, eq(product.id, offer.productId))
    .where(eq(linkResolutionRequest.id, requestId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    status: row.status,
    productSlug: row.slug ?? null,
    errorText: row.errorText,
  };
}
