/**
 * Europe/Istanbul takvim pencereleri: saat, gun, ISO hafta (pazartesi), ay.
 * Saf; Redis anahtarindaki donem kimligi ve arayuzdeki "yenilenir" zamani
 * buradan gelir. PostgreSQL tarafi ayni sinirlari `date_trunc(..., now() AT
 * TIME ZONE 'Europe/Istanbul')` ile hesaplar (`entitlement/charge.ts`).
 *
 * Turkiye 2016'dan beri sabit UTC+3, ama `entitlement/day.ts` gibi kaydirma
 * `Intl`'den okunur; boylece kural bir gun degisirse hesap kendiliginden uyar.
 */
import type { QuotaWindow } from "./policy.ts";

export const QUOTA_TIME_ZONE = "Europe/Istanbul";

const PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface WallClock {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
}

function wallClock(at: Date): WallClock & { minute: number; second: number } {
  const parts = Object.fromEntries(
    PARTS_FORMAT.formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Verilen andaki Istanbul kaydirmasi (ms): yerel duvar saati - UTC. */
function offsetMs(at: Date): number {
  const w = wallClock(at);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** Istanbul duvar saatinin UTC ani (Date.UTC tasmalari normallestirir). */
function fromWallClock(year: number, month: number, day: number, hour: number): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  // Iki gecis: kaydirma o anda degisseydi (DST) ikinci deger duzeltir.
  const first = asUtc - offsetMs(new Date(asUtc));
  return new Date(asUtc - offsetMs(new Date(first)));
}

/** Pazartesi = 0 ... pazar = 6, Istanbul takvim gunu icin. */
function mondayIndex(w: WallClock): number {
  return (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7;
}

export interface QuotaPeriod {
  window: QuotaWindow;
  /** Donemin baslangici (dahil), UTC an. */
  start: Date;
  /** Bir sonraki donemin baslangici (haric) = yenilenme ani. */
  end: Date;
  /** Anahtar icin kararli kimlik: `2026-10-08T19`, `2026-10-08`, `2026-10-05`(hafta), `2026-10`. */
  id: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function quotaPeriod(window: QuotaWindow, now: Date = new Date()): QuotaPeriod {
  const w = wallClock(now);
  switch (window) {
    case "hour": {
      const start = fromWallClock(w.year, w.month, w.day, w.hour);
      const end = fromWallClock(w.year, w.month, w.day, w.hour + 1);
      return { window, start, end, id: `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}` };
    }
    case "day": {
      const start = fromWallClock(w.year, w.month, w.day, 0);
      const end = fromWallClock(w.year, w.month, w.day + 1, 0);
      return { window, start, end, id: `${w.year}-${pad(w.month)}-${pad(w.day)}` };
    }
    case "week": {
      const startDay = w.day - mondayIndex(w);
      const start = fromWallClock(w.year, w.month, startDay, 0);
      const end = fromWallClock(w.year, w.month, startDay + 7, 0);
      const monday = new Date(Date.UTC(w.year, w.month - 1, startDay));
      const id = `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
      return { window, start, end, id };
    }
    case "month": {
      const start = fromWallClock(w.year, w.month, 1, 0);
      const end = fromWallClock(w.year, w.month + 1, 1, 0);
      return { window, start, end, id: `${w.year}-${pad(w.month)}` };
    }
  }
}
