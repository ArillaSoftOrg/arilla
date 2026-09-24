/**
 * D4 "kullanıcı başına günlük limit". `auth/search-wall.ts` ile aynı sabit
 * pencereli sayaç (`redis/counter.ts`), ama bu bir sürtünme değil sert bir
 * duraktır - embedding çağrısı gerçek para maliyeti taşır
 * (`docs/decisions/0015`), metin aramasının aksine. Anahtar girişliyse
 * `user_id`, değilse `session_id` üzerinden tutulur - görsel arama anonim de
 * çalışır.
 *
 * Redis erişilemezse `RedisUnavailableError` fırlatır; limit
 * doğrulanamadığı için embedding çağrısı yapılmamalıdır (fail-closed).
 */
import { incrementFixedWindow } from "../redis/counter.ts";

const WINDOW_SECONDS = 60 * 60 * 24;

function dailyLimit(): number {
  return Number(process.env.VISUAL_SEARCH_DAILY_LIMIT_PER_USER ?? 20);
}

export interface ImageSearchLimitResult {
  allowed: boolean;
}

export function imageSearchLimitKey(key: { userId: number | null; sessionId: string }): string {
  const scope = key.userId !== null ? `user:${key.userId}` : `session:${key.sessionId}`;
  return `image-search-limit:${scope}`;
}

export async function recordImageSearchAndCheckLimit(key: {
  userId: number | null;
  sessionId: string;
}): Promise<ImageSearchLimitResult> {
  const count = await incrementFixedWindow(imageSearchLimitKey(key), WINDOW_SECONDS);
  return { allowed: count <= dailyLimit() };
}
