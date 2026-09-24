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
 *
 * Redis erişilemezse `RedisUnavailableError` fırlatır (bkz. `redis/client.ts`).
 */
import { incrementFixedWindow } from "../redis/counter.ts";

const WINDOW_SECONDS = 60 * 60 * 24;

function freeSearchLimit(): number {
  return Number(process.env.FREE_SEARCHES_BEFORE_LOGIN ?? 3);
}

export interface SearchWallResult {
  shouldShowWall: boolean;
}

export function searchWallKey(sessionId: string): string {
  return `search-wall:${sessionId}`;
}

/** Girişi olan kullanıcılar için çağrılmamalı - duvar yalnızca anonim ziyaretçiler içindir. */
export async function recordSearchAndCheckWall(sessionId: string): Promise<SearchWallResult> {
  const count = await incrementFixedWindow(searchWallKey(sessionId), WINDOW_SECONDS);
  return { shouldShowWall: count > freeSearchLimit() };
}
