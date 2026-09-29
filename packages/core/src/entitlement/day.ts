/**
 * Europe/Istanbul takvim gunu. Islem icindeki kaynak SQL'dir
 * (`ISTANBUL_DAY_SQL`); bu fonksiyonlar arayuzdeki "bugun" ve "yenilenme
 * zamani" metni icindir. Turkiye 2016'dan beri sabit UTC+3, ama hesap
 * saat dilimi veritabanina bagli kalsin diye kaydirmayi `Intl`'den okur.
 */
import { ENTITLEMENT_TIME_ZONE } from "./config.ts";

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: ENTITLEMENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: ENTITLEMENT_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** `YYYY-MM-DD`, Istanbul saatine gore. */
export function istanbulDay(now: Date = new Date()): string {
  return DAY_FORMAT.format(now);
}

/** Verilen andaki Istanbul kaydirmasi (ms): yerel duvar saati - UTC. */
function offsetMs(at: Date): number {
  const parts = Object.fromEntries(
    PARTS_FORMAT.formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** Bir sonraki Istanbul 00:00'inin UTC ani. */
export function nextResetAt(now: Date = new Date()): Date {
  const [year, month, day] = istanbulDay(now).split("-").map(Number) as [number, number, number];
  const midnightAsUtc = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  // Iki gecis: kaydirma gece yarisinda degisseydi (DST) ikinci deger duzeltir.
  const first = midnightAsUtc - offsetMs(new Date(midnightAsUtc));
  return new Date(midnightAsUtc - offsetMs(new Date(first)));
}
