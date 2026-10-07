/**
 * Anonim ana sayfa için ilerleme sayısı önbelleği (karar 0065, karar 0043).
 *
 * Anonim ziyaret veritabanına her istekte gitmesin diye hesaplanan sayı
 * Redis'te `EARLY_ACCESS_PROGRESS_TTL_SECONDS` saniye tutulur; yeni kayıt en
 * geç bu sürede yansır. Redis'e ulaşılamazsa veritabanına DÜŞÜLMEZ (anonim
 * trafik veritabanını yormasın): `null` döner, çubuk gösterilmez. Uydurma
 * yedek sayı yoktur.
 */
import type { Database } from "@arilla/db";
import { getRedis } from "../redis/client.ts";
import { type EarlyAccessProgress, getEarlyAccessProgress } from "./early-access-progress.ts";

export const EARLY_ACCESS_PROGRESS_CACHE_KEY = "early-access:progress:v1";
export const EARLY_ACCESS_PROGRESS_TTL_SECONDS = 30;

export function parseCachedProgress(raw: string): EarlyAccessProgress | null {
  try {
    const value = JSON.parse(raw) as Partial<EarlyAccessProgress>;
    if (
      Number.isInteger(value.count) &&
      Number.isInteger(value.target) &&
      typeof value.percent === "number" &&
      Number.isFinite(value.percent) &&
      (value.count as number) >= 0 &&
      (value.target as number) > 0 &&
      (value.count as number) <= (value.target as number)
    ) {
      return {
        count: value.count as number,
        target: value.target as number,
        percent: value.percent,
      };
    }
  } catch {
    // bozuk önbellek: yok say, yeniden hesapla
  }
  return null;
}

/**
 * `getDb` tembeldir: önbellek isabetinde veritabanı bağlantısı hiç istenmez.
 */
export async function getCachedEarlyAccessProgress(
  getDb: () => Pick<Database, "select">,
): Promise<EarlyAccessProgress | null> {
  let redis: ReturnType<typeof getRedis>;
  try {
    redis = getRedis();
    const raw = await redis.get(EARLY_ACCESS_PROGRESS_CACHE_KEY);
    const cached = raw === null ? null : parseCachedProgress(raw);
    if (cached) return cached;
  } catch {
    return null;
  }
  let fresh: EarlyAccessProgress;
  try {
    fresh = await getEarlyAccessProgress(getDb());
  } catch {
    return null;
  }
  await redis
    .set(
      EARLY_ACCESS_PROGRESS_CACHE_KEY,
      JSON.stringify(fresh),
      "EX",
      EARLY_ACCESS_PROGRESS_TTL_SECONDS,
    )
    .catch(() => undefined);
  return fresh;
}

/** Yönetici sayıyı değiştirince önbellek hemen düşürülür (en iyi çaba). */
export async function invalidateEarlyAccessProgressCache(): Promise<void> {
  try {
    await getRedis().del(EARLY_ACCESS_PROGRESS_CACHE_KEY);
  } catch {
    // önbellek en geç TTL sonunda kendiliğinden yenilenir
  }
}
