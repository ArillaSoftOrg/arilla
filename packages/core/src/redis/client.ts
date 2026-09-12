/**
 * Paylaşılan Redis bağlantısı - `auth/rate-limit.ts` ve `auth/search-
 * wall.ts` aynı süreç-başına-tek-bağlantı desenini kullanır
 * (`packages/db/src/client.ts`'teki `getDatabase()` ile aynı fikir).
 */
import Redis from "ioredis";

let cached: Redis | undefined;

export function getRedis(): Redis {
  if (cached) return cached;
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL tanimli degil. .env.example dosyasina bakin.");
  }
  cached = new Redis(url);
  return cached;
}
