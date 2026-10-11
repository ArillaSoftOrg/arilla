/**
 * Link çözümleme işinin kuyruğa bırakılması (docs/decisions/0107).
 *
 * İki taşıma katmanı vardır; durumun tek doğrusu her ikisinde de PostgreSQL'deki
 * `link_resolution_request` satırıdır, kuyruk yalnızca "çalış" sinyalidir:
 *
 * - `redis` (varsayılan): `queue:link_resolution` listesine LPUSH; ayrı hostta
 *   çalışan Python worker'ı BRPOP ile alır (0014, 0035).
 * - `vercel`: Vercel Queues `link-resolution` topic'ine mesaj; aynı Vercel
 *   projesindeki özel Python abonesi (`services/ingest/collect/link/subscriber.py`)
 *   tetiklenir. Web onu çağırmaz, yalnızca mesaj bırakır.
 *
 * Mesaj her iki yolda da yalnızca `{ "request_id": "<uuid>" }`: URL, oturum ve
 * kullanıcı bilgisi kuyruğa girmez. Topic adı ve alan adı Python tarafıyla
 * (`collect/link/queue_handler.py`) elle senkronize edilir.
 */
import { getRedis, RedisUnavailableError } from "../redis/client.ts";

export const LINK_RESOLUTION_QUEUE_KEY = "queue:link_resolution";
export const LINK_RESOLUTION_TOPIC = "link-resolution";

/** Mesaj bu süre sonra düşer: eski bir istek (web 2 dk sonra öldü sayar) çözülmeye değmez. */
export const LINK_MESSAGE_RETENTION_SECONDS = 10 * 60;

export type LinkQueueBackend = "redis" | "vercel";

/** Yalnızca tam olarak `vercel` Vercel Queues'u seçer; geri kalan her değer güvenli varsayılandır. */
export function linkQueueBackend(
  env: Record<string, string | undefined> = process.env,
): LinkQueueBackend {
  return env.LINK_QUEUE_BACKEND?.trim().toLowerCase() === "vercel" ? "vercel" : "redis";
}

/**
 * Kuyruğa bırakılamadı. `RedisUnavailableError`'ın alt sınıfıdır: mevcut çağıranlar
 * (arama hakkı iadesi, sohbet `queue_unavailable` planı) bu tür hatayı zaten geçici
 * altyapı sorunu olarak ele alır; davranış taşıma katmanından bağımsız kalır.
 */
export class LinkQueueUnavailableError extends RedisUnavailableError {
  constructor(backend: LinkQueueBackend, options?: { cause?: unknown }) {
    super(`link cozumleme kuyrugu (${backend})`, options);
    this.name = "LinkQueueUnavailableError";
  }
}

export interface LinkQueueDeps {
  backend?: LinkQueueBackend;
  /** Test için: Redis LPUSH yerine. */
  redisPush?: (key: string, value: string) => Promise<unknown>;
  /** Test için: `@vercel/queue` `send` yerine. */
  sendMessage?: (
    topic: string,
    payload: { request_id: string },
    options: { idempotencyKey: string; retentionSeconds: number },
  ) => Promise<unknown>;
}

async function defaultSend(
  topic: string,
  payload: { request_id: string },
  options: { idempotencyKey: string; retentionSeconds: number },
): Promise<unknown> {
  // Redis yolunda SDK yüklenmesin (yerelde kimlik bilgisi gerekmez).
  const { send } = await import("@vercel/queue");
  return send(topic, payload, options);
}

/**
 * Çözümleme işini kuyruğa bırakır. Başarısızlıkta `LinkQueueUnavailableError`
 * (çağıran satırı `failed`/`queue_unavailable` yapar ve hakkı iade eder).
 */
export async function publishLinkResolution(
  requestId: string,
  deps: LinkQueueDeps = {},
): Promise<LinkQueueBackend> {
  const backend = deps.backend ?? linkQueueBackend();
  const payload = { request_id: requestId };
  try {
    if (backend === "vercel") {
      const send = deps.sendMessage ?? defaultSend;
      await send(LINK_RESOLUTION_TOPIC, payload, {
        // Aynı satır için çift gönderim (yeniden deneme) platformda düşer.
        idempotencyKey: requestId,
        retentionSeconds: LINK_MESSAGE_RETENTION_SECONDS,
      });
    } else {
      const push = deps.redisPush ?? ((key, value) => getRedis().lpush(key, value));
      await push(LINK_RESOLUTION_QUEUE_KEY, JSON.stringify(payload));
    }
  } catch (error) {
    throw new LinkQueueUnavailableError(backend, { cause: error });
  }
  return backend;
}
