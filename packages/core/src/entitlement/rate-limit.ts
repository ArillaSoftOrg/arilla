/**
 * Pahali arama istek hizi: kullanici basina dakikada 3, saatte 10
 * (docs/decisions/0047 madde 7). Mevcut sabit pencereli sayac
 * (`redis/counter.ts`). Hak ayirmadan ONCE cagrilir; reddedilen istek hak
 * harcamaz.
 *
 * Redis erisilemezse `RedisUnavailableError` firlatir; cagiran pahali
 * aramayi yapmaz (fail-closed, gorsel arama gunluk limitiyle ayni politika).
 */
import type Redis from "ioredis";
import { incrementFixedWindow } from "../redis/counter.ts";
import { AI_SEARCH_RATE_LIMITS } from "./config.ts";

export function aiSearchRateLimitKey(window: string, userId: number): string {
  return `ai-search-rl:${window}:user:${userId}`;
}

export async function checkAiSearchRateLimit(
  userId: number,
  client?: Pick<Redis, "multi" | "expire">,
): Promise<{ allowed: boolean }> {
  let allowed = true;
  for (const limit of AI_SEARCH_RATE_LIMITS) {
    const count = await incrementFixedWindow(
      aiSearchRateLimitKey(limit.name, userId),
      limit.windowSeconds,
      client,
    );
    if (count > limit.max) allowed = false;
  }
  return { allowed };
}
