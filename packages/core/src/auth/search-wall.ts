/**
 * decision 0002: `/ara` üzerinde ilk 2-3 sorgu serbest, sonrasında giriş
 * modali. Sayaç anonim `session_id` çerezine göre tutulur - localStorage
 * değil (CLAUDE.md: localStorage'sız çalışmayan bir akış kurulmaz). Güvenlik
 * değil sürtünme olduğu için (decision 0002 gerekçesi) günlük TTL ile
 * kendiliğinden sıfırlanır, kalıcı bir engel değildir.
 *
 * Basitleştirme: sayaç `/ara`'ya her yüklemede artar (sayfalama, sekme
 * değişimi dahil), yalnızca yeni bir sorgu metninde değil - decision 0002
 * bu ayrımı yapmıyor ve bu, salt sürtünme amaçlı bir mekanizma için gereksiz
 * karmaşıklık olurdu.
 */
import { getRedis } from "../redis/client.ts";

const WINDOW_SECONDS = 60 * 60 * 24;

function freeSearchLimit(): number {
  return Number(process.env.FREE_SEARCHES_BEFORE_LOGIN ?? 3);
}

export interface SearchWallResult {
  shouldShowWall: boolean;
}

/** Girişi olan kullanıcılar için çağrılmamalı - duvar yalnızca anonim ziyaretçiler içindir. */
export async function recordSearchAndCheckWall(sessionId: string): Promise<SearchWallResult> {
  const redis = getRedis();
  const key = `search-wall:${sessionId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }
  return { shouldShowWall: count > freeSearchLimit() };
}
