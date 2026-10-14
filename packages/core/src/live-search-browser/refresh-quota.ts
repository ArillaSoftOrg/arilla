/**
 * Trendyol katalog yenileme kotasi ve kontrol noktasi (karar 0117).
 *
 * Sozlu izinle verilen sinir: haftada en fazla 1, ayda en fazla 4 yenileme. Muhafazakar yorum:
 *  - Haftalik: bir dongunun baslangicindan sonraki 7 x 24 saat icinde yeni dongu BASLAMAZ
 *    (kayan pencere; takvim haftasi sinirinda arka arkaya iki dongu olmaz).
 *  - Aylik: Istanbul saatine (UTC+3, yaz saati yok) gore takvim ayinda en fazla 4 dongu baslar.
 *  - Baslayan her dongu kotadan duser: yarida kalsa, kapatilsa ya da hata verse de.
 *  - Kesilen dongu YALNIZCA kendi 7 gunluk penceresi icinde kaldigi yerden devam eder; pencere
 *    dolunca `expired` kapatilir, kalan isler bir sonraki donguye devreder (kota yeniden harcanmaz).
 *  - Dongu hedef listesi baslangicta sabitlenir (`targetsSha256`); liste degisirse devam REDDEDILIR.
 *  - Ayni dongude bir urun en fazla bir kez okunur (cursor tek yonlu ilerler).
 *
 * Saf mantiktir: dosya/veritabani yazimi cagirana aittir (betik atomik dosya yazimi yapar).
 */

export const REFRESH_LIMITS = { minIntervalHours: 7 * 24, perCalendarMonth: 4 } as const;
const ISTANBUL_OFFSET_MS = 3 * 3_600_000;
const HOUR = 3_600_000;

export type CycleStatus = "running" | "complete" | "expired" | "stopped";

export interface RefreshCycle {
  id: string;
  startedAt: string;
  /** Istanbul takvim ayi, "YYYY-MM". */
  monthKey: string;
  /** Devam icin son an: startedAt + 7 gun. */
  resumableUntil: string;
  status: CycleStatus;
  targetsSha256: string;
  total: number;
  /** Siradaki islenecek hedefin indeksi (tek yonlu). */
  cursor: number;
  observed: number;
  /** Fiyat/sayfa bulunamayan; uydurulmaz, yalnizca sayilir. */
  missing: number;
  failed: number;
  updatedAt: string;
  stopReason?: string;
}

export interface RefreshLedger {
  version: 1;
  cycles: RefreshCycle[];
}

export const emptyLedger = (): RefreshLedger => ({ version: 1, cycles: [] });

export function istanbulMonthKey(at: Date): string {
  const d = new Date(at.getTime() + ISTANBUL_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type StartDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "cycle_open" | "weekly_limit" | "monthly_limit";
      /** Bir sonraki dongunun en erken baslangici (bilinebiliyorsa). */
      nextAllowedAt: string | null;
    };

function nextMonthStart(at: Date): string {
  const d = new Date(at.getTime() + ISTANBUL_OFFSET_MS);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - ISTANBUL_OFFSET_MS;
  return new Date(first).toISOString();
}

export function canStartCycle(ledger: RefreshLedger, now: Date): StartDecision {
  const open = ledger.cycles.find(
    (c) => c.status === "running" && Date.parse(c.resumableUntil) > now.getTime(),
  );
  if (open) return { ok: false, reason: "cycle_open", nextAllowedAt: open.resumableUntil };
  const last = ledger.cycles.reduce<RefreshCycle | null>(
    (a, c) => (!a || Date.parse(c.startedAt) > Date.parse(a.startedAt) ? c : a),
    null,
  );
  if (last) {
    const earliest = Date.parse(last.startedAt) + REFRESH_LIMITS.minIntervalHours * HOUR;
    if (now.getTime() < earliest) {
      return { ok: false, reason: "weekly_limit", nextAllowedAt: new Date(earliest).toISOString() };
    }
  }
  const month = istanbulMonthKey(now);
  if (ledger.cycles.filter((c) => c.monthKey === month).length >= REFRESH_LIMITS.perCalendarMonth) {
    return { ok: false, reason: "monthly_limit", nextAllowedAt: nextMonthStart(now) };
  }
  return { ok: true };
}

export function startCycle(
  ledger: RefreshLedger,
  now: Date,
  targets: { sha256: string; total: number },
): { ledger: RefreshLedger; cycle: RefreshCycle } {
  const current = expireStale(ledger, now);
  const decision = canStartCycle(current, now);
  if (!decision.ok) throw new Error(`refresh_not_allowed:${decision.reason}`);
  if (!/^[0-9a-f]{64}$/.test(targets.sha256)) throw new Error("targets_sha256_invalid");
  const iso = now.toISOString();
  const cycle: RefreshCycle = {
    id: `cycle-${iso.replace(/[:.]/g, "-")}`,
    startedAt: iso,
    monthKey: istanbulMonthKey(now),
    resumableUntil: new Date(now.getTime() + REFRESH_LIMITS.minIntervalHours * HOUR).toISOString(),
    status: "running",
    targetsSha256: targets.sha256,
    total: targets.total,
    cursor: 0,
    observed: 0,
    missing: 0,
    failed: 0,
    updatedAt: iso,
  };
  return { ledger: { ...current, cycles: [...current.cycles, cycle] }, cycle };
}

/** Penceresi dolmus `running` donguleri `expired` yapar (silmez; kota sayiminda kalir). */
export function expireStale(ledger: RefreshLedger, now: Date): RefreshLedger {
  return {
    ...ledger,
    cycles: ledger.cycles.map((c) =>
      c.status === "running" && Date.parse(c.resumableUntil) <= now.getTime()
        ? {
            ...c,
            status: "expired" as const,
            updatedAt: now.toISOString(),
            stopReason: "window_elapsed",
          }
        : c,
    ),
  };
}

export type ResumeDecision =
  | { ok: true; cycle: RefreshCycle }
  | { ok: false; reason: "no_open_cycle" | "window_elapsed" | "targets_changed" };

export function resumeCycle(
  ledger: RefreshLedger,
  now: Date,
  targetsSha256: string,
): ResumeDecision {
  const running = ledger.cycles.find((c) => c.status === "running");
  if (!running) return { ok: false, reason: "no_open_cycle" };
  if (Date.parse(running.resumableUntil) <= now.getTime())
    return { ok: false, reason: "window_elapsed" };
  if (running.targetsSha256 !== targetsSha256) return { ok: false, reason: "targets_changed" };
  return { ok: true, cycle: running };
}

export type ItemOutcome = "observed" | "missing" | "failed";

/** Kontrol noktasi: bir hedef islendi; cursor yalnizca ileri gider. */
export function recordItem(
  cycle: RefreshCycle,
  index: number,
  outcome: ItemOutcome,
  now: Date,
): RefreshCycle {
  if (cycle.status !== "running") throw new Error("cycle_not_running");
  if (index !== cycle.cursor) throw new Error(`cursor_mismatch:${index}!=${cycle.cursor}`);
  const next: RefreshCycle = {
    ...cycle,
    cursor: cycle.cursor + 1,
    observed: cycle.observed + (outcome === "observed" ? 1 : 0),
    missing: cycle.missing + (outcome === "missing" ? 1 : 0),
    failed: cycle.failed + (outcome === "failed" ? 1 : 0),
    updatedAt: now.toISOString(),
  };
  return next.cursor >= next.total ? { ...next, status: "complete" } : next;
}

export function stopCycle(cycle: RefreshCycle, reason: string, now: Date): RefreshCycle {
  return { ...cycle, status: "stopped", stopReason: reason, updatedAt: now.toISOString() };
}

export function replaceCycle(ledger: RefreshLedger, cycle: RefreshCycle): RefreshLedger {
  return { ...ledger, cycles: ledger.cycles.map((c) => (c.id === cycle.id ? cycle : c)) };
}
