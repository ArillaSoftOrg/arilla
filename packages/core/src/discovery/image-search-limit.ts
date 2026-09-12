/**
 * D4 "kullanıcı başına günlük limit". `auth/search-wall.ts` ile aynı
 * INCR+EXPIRE deseni, ama bu bir sürtünme değil sert bir duraktır - embedding
 * çağrısı gerçek para maliyeti taşır (`docs/decisions/0015`), metin
 * aramasının aksine. Anahtar girişliyse `user_id`, değilse `session_id`
 * üzerinden tutulur - görsel arama anonim de çalışır.
 */
import { getRedis } from "../redis/client.ts";

const WINDOW_SECONDS = 60 * 60 * 24;

function dailyLimit(): number {
  return Number(process.env.VISUAL_SEARCH_DAILY_LIMIT_PER_USER ?? 20);
}

export interface ImageSearchLimitResult {
  allowed: boolean;
}

export async function recordImageSearchAndCheckLimit(key: {
  userId: number | null;
  sessionId: string;
}): Promise<ImageSearchLimitResult> {
  const redis = getRedis();
  const scope = key.userId !== null ? `user:${key.userId}` : `session:${key.sessionId}`;
  const redisKey = `image-search-limit:${scope}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, WINDOW_SECONDS);
  }
  return { allowed: count <= dailyLimit() };
}
