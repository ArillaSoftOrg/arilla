/**
 * Paylaşılan Redis bağlantısı - `auth/rate-limit.ts`, `auth/search-wall.ts`,
 * `discovery/image-search-limit.ts` ve `discovery/link-resolution.ts` aynı
 * süreç-başına-tek-bağlantı desenini kullanır (`packages/db/src/client.ts`'teki
 * `getDatabase()` ile aynı fikir).
 *
 * Hata davranışı: varsayılan ioredis seçenekleri erişilemeyen bir Redis'te
 * komutu ~20 yeniden deneme boyunca bekletir (`/ara` saniyelerce asılı
 * kalır). Burada her komutun üst sınırı `commandTimeout` ile sabittir; komut
 * bu süre içinde yanıt alamazsa hata fırlatır. Başarı taklit edilmez - karar
 * (fail-open / fail-closed) çağıranındır, `isRedisUnavailableError()` ile
 * ayırt eder.
 *
 * `enableOfflineQueue` bilerek açık kalır: kapalıyken soğuk başlangıçta
 * (serverless) bağlantı daha kurulmadan gelen ilk komut anında reddedilirdi.
 * Kuyruktaki komut da `commandTimeout` ile sınırlıdır (ioredis zamanlayıcıyı
 * kuyruğa almadan önce kurar).
 */
import Redis, { type RedisOptions } from "ioredis";

const CONNECT_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 2_500;
const MAX_RETRIES_PER_REQUEST = 1;
const MAX_RECONNECT_DELAY_MS = 2_000;

export class RedisConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisConfigError";
  }
}

export class RedisUnavailableError extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`redis erisilemedi: ${operation}`, options);
    this.name = "RedisUnavailableError";
  }
}

export function isRedisUnavailableError(error: unknown): error is RedisUnavailableError {
  return error instanceof RedisUnavailableError;
}

/** Yeniden bağlanma hiç durmaz (tekil istemci kalıcı olarak ölmesin), gecikme sınırlıdır. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(Math.max(attempt, 1) * 200, MAX_RECONNECT_DELAY_MS);
}

export interface RedisConnectionConfig {
  url: string;
  options: RedisOptions;
}

/** Saf fonksiyon - bağlantı açmaz, birim testlenir. */
export function redisOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RedisConnectionConfig {
  // Next dışı bağlamlarda (betik, test) `.env` tırnaklarıyla gelebilir.
  const url = env.REDIS_URL?.trim().replace(/^["']|["']$/g, "");
  if (!url) {
    throw new RedisConfigError("REDIS_URL tanimli degil. .env.example dosyasina bakin.");
  }
  if (!url.startsWith("redis://") && !url.startsWith("rediss://")) {
    throw new RedisConfigError("REDIS_URL redis:// ya da rediss:// ile baslamali.");
  }

  const options: RedisOptions = {
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: true,
    retryStrategy: reconnectDelayMs,
    // İlk komutta bağlanır; istemciyi oluşturmak tek başına soket açmaz.
    lazyConnect: true,
  };
  if (url.startsWith("rediss://")) {
    // ioredis rediss:// için TLS'i zaten açar; açıkça yazmak niyeti belgeler.
    options.tls = {};
  }
  return { url, options };
}

// Next dev HMR modülleri yeniden değerlendirir; globalThis önbelleği
// her yeniden yüklemede yeni bir bağlantı sızmasını önler.
const globalForRedis = globalThis as typeof globalThis & { __arillaRedis?: Redis };

export function getRedis(): Redis {
  const existing = globalForRedis.__arillaRedis;
  if (existing) return existing;

  const { url, options } = redisOptionsFromEnv();
  const client = new Redis(url, options);

  // Dinleyici olmadan ioredis her yeniden bağlanma denemesinde "Unhandled
  // error event" basar. Mesaj host içerebilir - yalnızca hata sınıfı/kodu
  // loglanır, bağlantı başına bir kez.
  let reported = false;
  client.on("error", (error: Error & { code?: string }) => {
    if (reported) return;
    reported = true;
    console.error(`[redis] baglanti hatasi: ${error.code ?? error.name}`);
  });
  client.on("ready", () => {
    reported = false;
  });

  globalForRedis.__arillaRedis = client;
  return client;
}
