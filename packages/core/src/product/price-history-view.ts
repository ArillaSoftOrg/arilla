/**
 * Fiyat geçmişi görünümü (karar 0168): günlük gözlem serisinden, seçilen döneme göre
 * özet ve grafik ölçeği. Saf işlevler - veritabanı yok, istemci de import eder
 * (`@arilla/core/price-history-view`).
 *
 * Veri kuralları:
 * - Nokta sentezlenmez. Seri yalnızca gerçekten gözlenen günlerden oluşur.
 * - Gözlem günü bir KONTROL anıdır, fiyatın değiştiği gün değil: `price_point` fiyat
 *   değişmese de her besleme koşusunda yazılır. Değişim tarihi bilinmez; yalnızca iki
 *   gözlem arasında olduğu söylenir.
 * - Seçilen dönem veri başlangıcından eskiyse kapsanmayan gün sayısı ayrıca bildirilir.
 */

export interface HistoryObservation {
  /** "YYYY-MM-DD" (günlük en düşük fiyatın gözlendiği gün). */
  date: string;
  /** Para biriminin küçük birimiyle (kuruş / cent). */
  priceMinor: number;
}

export type HistoryRangeKey = "7d" | "30d" | "90d" | "365d" | "all";

export interface HistoryRange {
  key: HistoryRangeKey;
  label: string;
  /** `all` için null. */
  days: number | null;
}

export const HISTORY_RANGES: readonly HistoryRange[] = [
  { key: "7d", label: "7 gün", days: 7 },
  { key: "30d", label: "30 gün", days: 30 },
  { key: "90d", label: "90 gün", days: 90 },
  { key: "365d", label: "1 yıl", days: 365 },
  { key: "all", label: "Tümü", days: null },
];

/** Sayfa tek ürünün bu kadar gününü sorgular (tek ürün, indeksli; tam tablo taraması yok). */
export const HISTORY_FETCH_DAYS = 730;

const DAY_MS = 86_400_000;
/** Bundan eski son gözlem "güncel olarak doğrulanamadı" sayılır. */
export const STALE_AFTER_DAYS = 3;

export function dayNumber(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return dayNumber(toIso) - dayNumber(fromIso);
}

/** Türkiye takvim günü, "YYYY-MM-DD". */
export function istanbulToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "2026-10-15" -> "15.10.2026". */
export function formatHistoryDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

export interface Extreme {
  priceMinor: number;
  date: string;
}

export interface HistoryGap {
  from: string;
  to: string;
  days: number;
}

export type ChangeDirection = "up" | "down" | "flat";

export interface HistoryChange {
  amountMinor: number;
  /** İşaretli yüzde; sıfır fiyatta null. */
  percent: number | null;
  direction: ChangeDirection;
  fromDate: string;
  toDate: string;
}

export interface HistoryView {
  range: HistoryRangeKey;
  /** Dönemin başlangıç günü; `all` için null. */
  windowStart: string | null;
  points: HistoryObservation[];
  min: Extreme | null;
  max: Extreme | null;
  /** Gözlenen günlerin ortalaması; en az 3 gözlem yoksa null. */
  average: number | null;
  change: HistoryChange | null;
  gaps: HistoryGap[];
  /** Dönemin başında, ilk gözlemden önce kalan (veri olmayan) gün sayısı. */
  uncoveredDays: number;
  /** Son gözlemin üzerinden geçen gün; seri boşsa null. */
  daysSinceLast: number | null;
  stale: boolean;
}

export function sortObservations(points: readonly HistoryObservation[]): HistoryObservation[] {
  return [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Ardışık gözlemler arasındaki "boşluk" eşiği: en az 3 gün ve medyan aralığın 2 katı. */
export function gapThresholdDays(points: readonly HistoryObservation[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev && cur) diffs.push(daysBetween(prev.date, cur.date));
  }
  if (diffs.length === 0) return 3;
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)] ?? 1;
  return Math.max(3, median * 2);
}

export function findGaps(points: readonly HistoryObservation[]): HistoryGap[] {
  const threshold = gapThresholdDays(points);
  const gaps: HistoryGap[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    const days = daysBetween(prev.date, cur.date);
    if (days > threshold) gaps.push({ from: prev.date, to: cur.date, days });
  }
  return gaps;
}

export function buildChange(points: readonly HistoryObservation[]): HistoryChange | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) return null;
  const amountMinor = last.priceMinor - first.priceMinor;
  return {
    amountMinor,
    percent: first.priceMinor > 0 ? (amountMinor / first.priceMinor) * 100 : null,
    direction: amountMinor > 0 ? "up" : amountMinor < 0 ? "down" : "flat",
    fromDate: first.date,
    toDate: last.date,
  };
}

/** İlk gözlemi kapsayan en küçük dönem (en çok 90 gün): açılışta boş görünen dönem seçilmez. */
export function defaultRange(
  points: readonly HistoryObservation[],
  today: string,
  horizonDays: number = HISTORY_FETCH_DAYS,
): HistoryRangeKey {
  const first = sortObservations(points)[0];
  if (!first) return "90d";
  const span = daysBetween(first.date, today);
  for (const range of HISTORY_RANGES) {
    if (range.days === null || range.days > 90 || range.days > horizonDays) continue;
    if (span <= range.days) return range.key;
  }
  return "90d";
}

/** Sorgu ufkunu (gün) aşmayan dönemler; `all` her zaman vardır. */
export function availableRanges(horizonDays: number): HistoryRange[] {
  return HISTORY_RANGES.filter((r) => r.days === null || r.days <= horizonDays);
}

export function buildHistoryView(
  all: readonly HistoryObservation[],
  range: HistoryRangeKey,
  today: string,
): HistoryView {
  const sorted = sortObservations(all);
  const def = HISTORY_RANGES.find((r) => r.key === range);
  const days = def?.days ?? null;
  const windowStart =
    days === null ? null : new Date((dayNumber(today) - days) * DAY_MS).toISOString().slice(0, 10);
  const points = windowStart === null ? sorted : sorted.filter((p) => p.date >= windowStart);

  let min: Extreme | null = null;
  let max: Extreme | null = null;
  let sum = 0;
  for (const p of points) {
    sum += p.priceMinor;
    if (!min || p.priceMinor < min.priceMinor) min = { priceMinor: p.priceMinor, date: p.date };
    if (!max || p.priceMinor > max.priceMinor) max = { priceMinor: p.priceMinor, date: p.date };
  }

  // Kapsanmayan gün: dönem başı, TÜM serinin ilk gözleminden önceyse (veri yok).
  const firstEver = sorted[0];
  const uncoveredDays =
    windowStart !== null && firstEver
      ? Math.max(0, Math.min(days ?? 0, daysBetween(windowStart, firstEver.date)))
      : 0;

  const lastPoint = sorted[sorted.length - 1];
  const daysSinceLast = lastPoint ? Math.max(0, daysBetween(lastPoint.date, today)) : null;

  return {
    range,
    windowStart,
    points,
    min,
    max,
    average: points.length >= 3 ? Math.round(sum / points.length) : null,
    change: buildChange(points),
    gaps: findGaps(points),
    uncoveredDays,
    daysSinceLast,
    stale: daysSinceLast !== null && daysSinceLast > STALE_AFTER_DAYS,
  };
}

/**
 * Y ekseni etki alanı. Küçük oynamalar büyük görünmesin diye alan en az fiyatın %10'u
 * kadar geniştir: 10,99 -> 11,02 neredeyse düz bir çizgi olarak çizilir.
 */
export function yDomain(min: number, max: number): [number, number] {
  const minSpan = Math.max(Math.round(max * 0.1), 100);
  const span = max - min;
  if (span >= minSpan) {
    const pad = Math.round(span * 0.08);
    return [Math.max(0, min - pad), max + pad];
  }
  const mid = (min + max) / 2;
  let lo = Math.round(mid - minSpan / 2);
  let hi = Math.round(mid + minSpan / 2);
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  return [lo, hi];
}
