/**
 * Link aramasının kuyruğa alma ve durum tarafı (docs/decisions/0014, 0031).
 * `docs/schema.sql` "Kök catch-all'ın tekil link çözümleme durumu" notu:
 * Python worker aynı `collect.link.resolver.resolve_url`'i bu kuyruktan
 * tetikler (`services/ingest/collect/link/__main__.py --worker`).
 *
 * Kuyruk anahtarı iki tarafta da AYNI OLMALI - burada değişirse Python
 * tarafında da değişmeli (elle senkronize edilir, paylaşılan bir sabit
 * yok çünkü diller arasında import edilemez).
 *
 * Önbellek: `normalized_url` oturumlar arası anahtardır. Aynı ürün linki
 * `RESOLVED_TTL_MS` içinde yeniden getirilmez; başarısız bir sonuç kısa bir
 * süre (`FAILED_TTL_MS`) hatırlanır ki 429 veren bir siteye art arda gidilmesin.
 * Sonuç sayfası isteğin kimliğine değil adrese bağlıdır: paylaşılan bir
 * `/ara/link?url=...` başka bir oturumda da aynı sonucu gösterir, oturum
 * bilgisi (session_id, user_id) hiçbir zaman dışarı çıkmaz.
 */
import { type Database, linkResolutionRequest, offer, product } from "@arilla/db";
import { and, desc, eq, gt, inArray, isNotNull, notInArray, or } from "drizzle-orm";
import { getRedis, RedisUnavailableError } from "../redis/client.ts";
import { checkLinkSearchUrl } from "./link-search-input.ts";
import { InvalidUrlError } from "./normalize-url.ts";

export const LINK_RESOLUTION_QUEUE_KEY = "queue:link_resolution";

/** Çözülmüş bir link bu süre boyunca yeniden getirilmez. */
export const RESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
/** Başarısız sonuç bu süre hatırlanır (negatif önbellek). */
export const FAILED_TTL_MS = 10 * 60 * 1000;
/**
 * Bu süreden eski 'queued'/'processing' satırı ölü sayılır (worker düştü,
 * mesaj kayboldu): üzerine yeni istek açılır, arayüz sonsuza kadar beklemez.
 */
export const IN_FLIGHT_TTL_MS = 2 * 60 * 1000;

/** Hatırlanmayan hata kodları: altyapı sorunu, sitenin durumu değil. */
const TRANSIENT_ERROR_CODES = ["queue_unavailable", "unexpected"];

export class LinkSearchLimitError extends Error {
  constructor() {
    super("link araması günlük limiti doldu");
    this.name = "LinkSearchLimitError";
  }
}

export interface EnqueueLinkResolutionInput {
  urlRaw: string;
  sessionId: string;
  userId: number | null;
}

export interface EnqueueLinkResolutionOptions {
  /** Yalnızca YENİ bir getirme açılacaksa çağrılır; önbellek isabeti sayılmaz. */
  checkLimit?: () => Promise<{ allowed: boolean }>;
  now?: Date;
}

type RequestRow = typeof linkResolutionRequest.$inferSelect;

/**
 * `normalized_url` için hâlâ geçerli olan en yeni istek: çözülmüş (TTL içinde),
 * yakın zamanda başarısız ya da hâlâ işleniyor. Yoksa `null`.
 */
export async function findReusableLinkRequest(
  db: Database,
  normalizedUrl: string,
  now: Date = new Date(),
): Promise<RequestRow | null> {
  const at = now.getTime();
  const rows = await db
    .select()
    .from(linkResolutionRequest)
    .where(
      and(
        eq(linkResolutionRequest.normalizedUrl, normalizedUrl),
        or(
          and(
            eq(linkResolutionRequest.status, "resolved"),
            gt(linkResolutionRequest.finishedAt, new Date(at - RESOLVED_TTL_MS)),
          ),
          and(
            eq(linkResolutionRequest.status, "failed"),
            gt(linkResolutionRequest.finishedAt, new Date(at - FAILED_TTL_MS)),
            isNotNull(linkResolutionRequest.errorCode),
            notInArray(linkResolutionRequest.errorCode, TRANSIENT_ERROR_CODES),
          ),
          and(
            inArray(linkResolutionRequest.status, ["queued", "processing"]),
            gt(linkResolutionRequest.createdAt, new Date(at - IN_FLIGHT_TTL_MS)),
          ),
        ),
      ),
    )
    .orderBy(desc(linkResolutionRequest.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Linki kuyruğa alır ya da geçerli bir önceki isteği döndürür. Adres
 * `checkLinkSearchUrl`'den geçmezse `InvalidUrlError` - Python tarafına
 * geçersiz ya da iç ağa giden bir şey hiç gitmez.
 */
export async function enqueueLinkResolution(
  db: Database,
  input: EnqueueLinkResolutionInput,
  options: EnqueueLinkResolutionOptions = {},
): Promise<{ requestId: string; reused: boolean }> {
  const checked = checkLinkSearchUrl(input.urlRaw);
  if (!checked.ok) throw new InvalidUrlError(`link aramasına uygun değil: ${checked.reason}`);
  const normalizedUrl = checked.normalized.url;

  const existing = await findReusableLinkRequest(db, normalizedUrl, options.now);
  if (existing) return { requestId: existing.id, reused: true };

  if (options.checkLimit) {
    const limit = await options.checkLimit();
    if (!limit.allowed) throw new LinkSearchLimitError();
  }

  const [created] = await db
    .insert(linkResolutionRequest)
    .values({
      // Worker kanonik adresi getirir: izleme parametresi ve fragment yok.
      urlRaw: normalizedUrl,
      normalizedUrl,
      sessionId: input.sessionId,
      userId: input.userId,
    })
    .returning({ id: linkResolutionRequest.id });
  if (!created) {
    throw new Error("link_resolution_request insert boş sonuç döndürdü");
  }

  try {
    await getRedis().lpush(LINK_RESOLUTION_QUEUE_KEY, JSON.stringify({ request_id: created.id }));
  } catch (error) {
    // Satır 'queued' kalırsa hiçbir worker onu almaz; 'failed' işaretlenir
    // (best-effort) ve hata çağırana iletilir. Kod geçici sayılır: bir sonraki
    // deneme önbelleğe takılmaz.
    await db
      .update(linkResolutionRequest)
      .set({
        status: "failed",
        errorText: "queue_unavailable",
        errorCode: "queue_unavailable",
        finishedAt: new Date(),
      })
      .where(eq(linkResolutionRequest.id, created.id))
      .catch(() => undefined);
    throw new RedisUnavailableError("link cozumleme kuyrugu", { cause: error });
  }

  return { requestId: created.id, reused: false };
}

export interface LinkResolutionStatus {
  status: "queued" | "processing" | "resolved" | "failed";
  productSlug: string | null;
  errorText: string | null;
  errorCode: string | null;
}

export async function getLinkResolutionStatus(
  db: Database,
  requestId: string,
): Promise<LinkResolutionStatus | null> {
  // Kimlik UUID değilse Postgres sorguyu hata ile keser; "bulunamadı" sayılır.
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return null;
  const rows = await db
    .select({
      status: linkResolutionRequest.status,
      errorText: linkResolutionRequest.errorText,
      errorCode: linkResolutionRequest.errorCode,
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
    errorCode: row.errorCode,
  };
}
