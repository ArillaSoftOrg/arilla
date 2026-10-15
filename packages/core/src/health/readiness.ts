/**
 * Hazirlik (readiness) denetimi (docs/decisions/0109).
 *
 * Canlilik (`/api/health`) hicbir bagimliliga dokunmaz: yalnizca surecin
 * istek alabildigini soyler ve Docker `HEALTHCHECK`'i bununla yapilir. Redis
 * ya da veritabani gecici koptu diye web konteyneri yeniden baslatilmaz.
 *
 * Hazirlik (`/api/health/ready`) ise veritabanina (`SELECT 1`) ve Redis'e
 * (`PING`) gercekten ulasildigini sorar. Dagitim betigi yeni surumu trafige
 * almadan once bununla kapi kurar; basarisizsa onceki surume doner.
 *
 * Gizlilik: yanit yalnizca bilesen adlari ve `ok`/`fail` icerir; hata mesaji,
 * adres, surum ya da sure DONMEZ. Kisisel veri yoktur. Yuku sinirlamak icin
 * sonuc kisa sure onbellege alinir ve eszamanli cagrilar tek denetimi paylasir.
 */
import { getDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { getRedis } from "../redis/client.ts";

export type HealthCheckName = "database" | "redis";
export type HealthCheckStatus = "ok" | "fail";

export interface ReadinessReport {
  ready: boolean;
  checks: Record<HealthCheckName, HealthCheckStatus>;
}

export interface ReadinessChecks {
  database: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

/** Her bilesen icin ust sinir; `/api/health/ready` bunun uzerinde asilmaz. */
export const READINESS_CHECK_TIMEOUT_MS = 2_000;
/** Sonuc bu sure yeniden kullanilir (yogun yoklamada DB'yi yormamak icin). */
export const READINESS_CACHE_MS = 2_000;

async function withTimeout(task: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    // Mesaj bilerek yutulur: adres/parola icerebilir, yanita da loga da girmez.
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Saf denetim: bagimliliklar parametredir, onbellek yoktur. */
export async function checkReadiness(
  checks: ReadinessChecks,
  timeoutMs: number = READINESS_CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const [database, redis] = await Promise.all([
    withTimeout(checks.database, timeoutMs),
    withTimeout(checks.redis, timeoutMs),
  ]);
  return {
    ready: database && redis,
    checks: { database: database ? "ok" : "fail", redis: redis ? "ok" : "fail" },
  };
}

export const defaultReadinessChecks: ReadinessChecks = {
  database: () => getDatabase().execute(sql`select 1`),
  redis: () => getRedis().ping(),
};

/**
 * Onbellekli ve tek-ucuslu denetleyici. Basarisiz sonuc da onbelleklenir
 * (kisa sure): cokmus bir veritabanina saniyede yuzlerce baglanti denemesi
 * yapilmaz.
 */
export function createReadinessProbe(
  checks: ReadinessChecks = defaultReadinessChecks,
  options: { cacheMs?: number; timeoutMs?: number; now?: () => number } = {},
): () => Promise<ReadinessReport> {
  const cacheMs = options.cacheMs ?? READINESS_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; report: ReadinessReport } | undefined;
  let inFlight: Promise<ReadinessReport> | undefined;

  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.report;
    if (inFlight) return inFlight;
    inFlight = checkReadiness(checks, options.timeoutMs)
      .then((report) => {
        cached = { at: now(), report };
        return report;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/** Surec basina tek denetleyici; route'lar bunu kullanir. */
export const probeReadiness = createReadinessProbe();
