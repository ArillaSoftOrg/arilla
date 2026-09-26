/**
 * Link araması günlük limiti (docs/decisions/0035). `image-search-limit.ts`
 * ile aynı sabit pencereli sayaç: her YENİ çözümleme bir dış sayfa isteği ve
 * çoğu zaman ücretli bir görsel embedding'i demek. Önbellekten dönen sonuç
 * (aynı link, TTL içinde) sayılmaz.
 *
 * Redis erişilemezse `RedisUnavailableError` fırlatır; kuyruk da Redis'te
 * olduğu için link araması zaten çalışamaz (fail-closed).
 */
import { incrementFixedWindow } from "../redis/counter.ts";

const WINDOW_SECONDS = 60 * 60 * 24;

function dailyLimit(): number {
  const value = Number(process.env.LINK_SEARCH_DAILY_LIMIT_PER_USER ?? 30);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

export function linkSearchLimitKey(key: { userId: number | null; sessionId: string }): string {
  const scope = key.userId !== null ? `user:${key.userId}` : `session:${key.sessionId}`;
  return `link-search-limit:${scope}`;
}

export async function recordLinkSearchAndCheckLimit(key: {
  userId: number | null;
  sessionId: string;
}): Promise<{ allowed: boolean }> {
  const count = await incrementFixedWindow(linkSearchLimitKey(key), WINDOW_SECONDS);
  return { allowed: count <= dailyLimit() };
}
