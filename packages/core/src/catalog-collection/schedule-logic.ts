/**
 * Zamanlanmis yonetici tarayicisi toplamasi: SAF kurallar (karar 0221 §B). Tarayiciya da
 * paketlenir; veritabani, ag ve saat okumaz (zaman parametredir).
 *
 * Kaynaktan bagimsizdir (`collection_schedule` kaynak basina tek satir). Kota burada
 * HESAPLANMAZ: `getCollectionStatus` (ve son karar olarak veritabani tetikleyicisi) verir; bu
 * modul yalniz "simdi baslat / bekle / kapali" kararini ve bir sonraki yoklama zamanini uretir.
 */

/** Zamanlanmis koşu basina sayfa tavani: kosunun istek butcesiyle ayni (0118: 500). */
export const MAX_SCHEDULE_TARGETS = 500;
export const MIN_PACE_SECONDS = 20;
export const MAX_PACE_SECONDS = 600;
/** Kapali/engelli durumda eklentinin yonetim sayfasini yeniden acmadan once bekledigi sure. */
export const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Zamani gelmis ama baslamamis koşu bu kadar gecikirse yoneticiye bulgu olur. */
export const OVERDUE_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

export type ScheduleBlock =
  | "flag_off"
  | "schedule_off"
  | "source_disabled"
  | "no_targets"
  | "open_run"
  | "interval"
  | "month"
  | "volume";

export type ScheduleDecision =
  | { action: "start" }
  /** Onceki zamanlanmis koşu yarida kaldi (sayfa/tarayici kapandi): kapatilip bildirilir. */
  | { action: "interrupted"; runId: number }
  | { action: "wait"; reason: ScheduleBlock; nextCheckAt: Date };

export interface ScheduleInputs {
  flagEnabled: boolean;
  scheduleEnabled: boolean;
  sourceEnabled: boolean;
  targetCount: number;
  quota: {
    canStart: boolean;
    blockedBy: string | null;
    nextAllowedAt: Date | null;
  };
  openRun: { id: number; scheduled: boolean } | null;
}

function firstOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5));
}

/** Simdi ne yapilmali. Kota kararini `quota`dan alir; asla gevsetmez. */
export function scheduleDecision(input: ScheduleInputs, now: Date): ScheduleDecision {
  const later = new Date(now.getTime() + RECHECK_MS);
  const wait = (reason: ScheduleBlock, at: Date = later): ScheduleDecision => ({
    action: "wait",
    reason,
    nextCheckAt: at,
  });
  if (!input.flagEnabled) return wait("flag_off");
  if (!input.scheduleEnabled) return wait("schedule_off");
  if (!input.sourceEnabled) return wait("source_disabled");
  if (input.targetCount === 0) return wait("no_targets");
  if (input.openRun) {
    // Elle acilmis kosuya zamanlayici dokunmaz; kendi yarim kalanini kapatir.
    return input.openRun.scheduled
      ? { action: "interrupted", runId: input.openRun.id }
      : wait("open_run");
  }
  if (input.quota.canStart) return { action: "start" };
  switch (input.quota.blockedBy) {
    case "interval":
      return wait(
        "interval",
        input.quota.nextAllowedAt && input.quota.nextAllowedAt > now
          ? input.quota.nextAllowedAt
          : later,
      );
    case "month":
      return wait("month", firstOfNextMonthUtc(now));
    case "disabled":
      return wait("source_disabled");
    case "open_run":
      return wait("open_run");
    default:
      return wait("volume");
  }
}

/** Iki sayfa acilisi arasi bekleme: en az `paceSeconds`, ustune %0-50 rastgele. */
export function paceDelayMs(paceSeconds: number, random: number): number {
  const pace = Math.min(Math.max(Math.round(paceSeconds), MIN_PACE_SECONDS), MAX_PACE_SECONDS);
  const r = Math.min(Math.max(random, 0), 1);
  return Math.round(pace * 1000 * (1 + r * 0.5));
}

/** Kullanicinin yazdigi adres listesini temizler: bos/yinelenen atilir, gecersizler sayilir. */
export function normalizeScheduleTargets(
  raw: unknown,
  isValid: (url: string) => boolean,
): { urls: string[]; invalid: number; overflow: number } {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n/) : [];
  const urls: string[] = [];
  let invalid = 0;
  let overflow = 0;
  for (const item of list) {
    if (typeof item !== "string") {
      invalid += 1;
      continue;
    }
    const url = item.trim();
    if (!url) continue;
    if (url.length > 2048 || !isValid(url)) {
      invalid += 1;
      continue;
    }
    if (urls.includes(url)) continue;
    if (urls.length >= MAX_SCHEDULE_TARGETS) {
      overflow += 1;
      continue;
    }
    urls.push(url);
  }
  return { urls, invalid, overflow };
}

export type ScheduleOutcome =
  | "completed"
  | "aborted"
  | "blocked"
  | "budget"
  | "interrupted"
  | "start_refused"
  | "error";

/** Aktarim durmasi -> kayitli sonuc. Butce dolmasi basarisizlik degildir ama gorunur kalir. */
export function outcomeForStop(stop: "budget" | "blocked" | null): ScheduleOutcome {
  if (stop === "blocked") return "blocked";
  if (stop === "budget") return "budget";
  return "completed";
}

/** Yonetici bulgusu gerektiren sonuc mu (basarisiz/yarim). */
export function isFailedOutcome(outcome: ScheduleOutcome | null): boolean {
  return (
    outcome === "aborted" ||
    outcome === "blocked" ||
    outcome === "interrupted" ||
    outcome === "start_refused" ||
    outcome === "error"
  );
}
