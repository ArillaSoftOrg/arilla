/**
 * Erken erisim ilerleme cubugu (docs/decisions/0065).
 *
 * Gosterilen sayi = platform disi gercek basvurular (`early_access_counter`,
 * yonetici elle gunceller) + `early_access` tablosundaki gercek kayitlar,
 * hedefle sinirlanir. Takvime bagli otomatik ya da rastgele artis YOKTUR:
 * her kisi gercek bir basvurudur.
 *
 * Sayi her istekte veritabanindan hesaplanir (istemci deposu yok, cache yok):
 * yeni bir kayit bir sonraki istekte +1 gorunur, sayfa yenilemek sayiyi
 * degistirmez. Istek yolunda model cagrisi yok (CLAUDE.md kural 1).
 */
import { type Database, earlyAccess, earlyAccessCounter } from "@arilla/db";
import { count, eq } from "drizzle-orm";

export const EARLY_ACCESS_TARGET = 5000;

export interface EarlyAccessProgress {
  /** Gosterilen kisi sayisi, `target` ile sinirli. */
  count: number;
  target: number;
  /** 0-100, bir ondalik. */
  percent: number;
}

function wholeNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Saf hesap: ayni girdi her zaman ayni cikti. */
export function computeEarlyAccessProgress(
  offPlatformCount: number,
  onPlatformCount: number,
  target: number = EARLY_ACCESS_TARGET,
): EarlyAccessProgress {
  const safeTarget = Math.max(1, wholeNonNegative(target));
  const total = wholeNonNegative(offPlatformCount) + wholeNonNegative(onPlatformCount);
  const shown = Math.min(safeTarget, total);
  const percent = Math.min(100, Math.round((shown / safeTarget) * 1000) / 10);
  return { count: shown, target: safeTarget, percent };
}

export interface EarlyAccessCounts {
  offPlatformCount: number;
  onPlatformCount: number;
}

export async function readEarlyAccessCounts(
  db: Pick<Database, "select">,
): Promise<EarlyAccessCounts> {
  const [counter] = await db
    .select({ offPlatformCount: earlyAccessCounter.offPlatformCount })
    .from(earlyAccessCounter)
    .where(eq(earlyAccessCounter.id, 1))
    .limit(1);
  const [signups] = await db.select({ total: count() }).from(earlyAccess);
  return {
    offPlatformCount: counter?.offPlatformCount ?? 0,
    onPlatformCount: Number(signups?.total ?? 0),
  };
}

export async function getEarlyAccessProgress(
  db: Pick<Database, "select">,
): Promise<EarlyAccessProgress> {
  const counts = await readEarlyAccessCounts(db);
  return computeEarlyAccessProgress(counts.offPlatformCount, counts.onPlatformCount);
}
