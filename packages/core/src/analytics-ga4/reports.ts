/**
 * Trafik raporları (karar 0087). Rapor tanımları KODDA SABİT; kullanıcı
 * girdisi yalnızca doğrulanmış tarih aralığı ve zaman dilimidir. Metrik ve
 * boyut adları GA4 Data API şemasında doğrulandı (9 Ekim 2026):
 * activeUsers, newUsers, sessions, screenPageViews, engagementRate (0-1
 * oran); date, isoYearIsoWeek, yearMonth, sessionDefaultChannelGroup,
 * sessionSource, sessionMedium, pagePath, deviceCategory, country,
 * countryId, region.
 */
import type { Ga4Report, Ga4Row } from "./data-api.ts";

export const TRAFFIC_TIME_ZONE = "Europe/Istanbul";
export const TRAFFIC_PRESETS = [7, 28, 90] as const;
export type TrafficPreset = (typeof TRAFFIC_PRESETS)[number];
export const TRAFFIC_DEFAULT_PRESET: TrafficPreset = 28;
/** Özel aralık en çok bu kadar gün (önceki dönemle birlikte kota içinde kalsın). */
export const TRAFFIC_MAX_DAYS = 366;
/** GA4 öncesi tarih istenmez. */
const EARLIEST = "2020-01-01";

export const TRAFFIC_GRANULARITIES = ["gun", "hafta", "ay"] as const;
export type TrafficGranularity = (typeof TRAFFIC_GRANULARITIES)[number];

/** Bu kadar kullanıcıdan az olan coğrafya/kaynak satırı "Diğer"e katılır. */
export const TRAFFIC_SMALL_CELL_MIN = 5;

export interface DateRange {
  start: string;
  end: string;
}

export interface TrafficRange {
  preset: TrafficPreset | null;
  current: DateRange;
  previous: DateRange;
  days: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `Date` → İstanbul takvim günü (YYYY-MM-DD). */
export function istanbulDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TRAFFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function toUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isRealDate(value: string): boolean {
  return ISO_DATE.test(value) && fromUtc(toUtc(value)) === value;
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

export function daysBetweenInclusive(range: DateRange): number {
  return Math.round((toUtc(range.end) - toUtc(range.start)) / DAY_MS) + 1;
}

function previousOf(current: DateRange, days: number): DateRange {
  const end = addDays(current.start, -1);
  return { start: addDays(end, -(days - 1)), end };
}

export class TrafficRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrafficRangeError";
  }
}

/**
 * Hazır aralık: bugün HARİÇ son N gün (GA4 arayüzüyle aynı; tamamlanmış
 * günler önbellekte kararlı kalır). Özel aralık: bitiş en geç bugün.
 * Geçersiz özel aralık `TrafficRangeError` fırlatır; parametre yoksa hazır.
 */
export function parseTrafficRange(
  input: { gun?: string; baslangic?: string; bitis?: string },
  now: Date,
): TrafficRange {
  const today = istanbulDate(now);
  if (input.baslangic || input.bitis) {
    const start = input.baslangic ?? "";
    const end = input.bitis ?? "";
    if (!isRealDate(start) || !isRealDate(end))
      throw new TrafficRangeError("Tarih biçimi geçersiz.");
    if (start > end) throw new TrafficRangeError("Başlangıç bitişten sonra olamaz.");
    if (end > today) throw new TrafficRangeError("Bitiş tarihi gelecekte olamaz.");
    if (start < EARLIEST) throw new TrafficRangeError("Bu kadar eski tarih istenemez.");
    const current = { start, end };
    const days = daysBetweenInclusive(current);
    if (days > TRAFFIC_MAX_DAYS) {
      throw new TrafficRangeError(`Aralık en çok ${TRAFFIC_MAX_DAYS} gün olabilir.`);
    }
    return { preset: null, current, previous: previousOf(current, days), days };
  }
  const preset = (TRAFFIC_PRESETS as readonly number[]).includes(Number(input.gun))
    ? (Number(input.gun) as TrafficPreset)
    : TRAFFIC_DEFAULT_PRESET;
  const end = addDays(today, -1);
  const current = { start: addDays(end, -(preset - 1)), end };
  return { preset, current, previous: previousOf(current, preset), days: preset };
}

export function defaultGranularity(days: number): TrafficGranularity {
  if (days <= 31) return "gun";
  if (days <= 120) return "hafta";
  return "ay";
}

export function parseGranularity(raw: string | undefined, days: number): TrafficGranularity {
  return (TRAFFIC_GRANULARITIES as readonly string[]).includes(raw ?? "")
    ? (raw as TrafficGranularity)
    : defaultGranularity(days);
}

const GRANULARITY_DIMENSION: Record<TrafficGranularity, string> = {
  gun: "date",
  hafta: "isoYearIsoWeek",
  ay: "yearMonth",
};

/** ISO 8601 hafta: (yıl, hafta). */
function isoWeek(date: string): { year: number; week: number } {
  const d = new Date(toUtc(date));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return {
    year: d.getUTCFullYear(),
    week: Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7),
  };
}

/** Gün → GA4 boyut değeri (`20261009`, `202641`, `202610`). */
export function bucketKey(date: string, granularity: TrafficGranularity): string {
  if (granularity === "gun") return date.replaceAll("-", "");
  if (granularity === "ay") return date.slice(0, 7).replace("-", "");
  const { year, week } = isoWeek(date);
  return `${year}${String(week).padStart(2, "0")}`;
}

/** Aralıktaki tüm kovalar sırayla (GA4 sıfır satırları döndürmez; boşluk 0 ile dolar). */
export function bucketsOf(range: DateRange, granularity: TrafficGranularity): string[] {
  const keys: string[] = [];
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) {
    const key = bucketKey(day, granularity);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

/* ---- İstek gövdeleri ---- */

const TOTAL_METRICS = ["activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate"];
const SERIES_METRICS = ["activeUsers", "sessions", "screenPageViews"];

function metrics(names: readonly string[]) {
  return names.map((name) => ({ name }));
}

function dims(names: readonly string[]) {
  return names.map((name) => ({ name }));
}

function byMetricDesc(name: string) {
  return [{ metric: { metricName: name }, desc: true }];
}

export type TrafficScope = "full" | "summary";

export interface TrafficRequestPlan {
  /** Toplu istekler (her biri en çok 5 rapor). */
  batches: Record<string, unknown>[][];
}

export function trafficRequests(
  range: TrafficRange,
  granularity: TrafficGranularity,
  scope: TrafficScope,
): TrafficRequestPlan {
  const current = [{ startDate: range.current.start, endDate: range.current.end }];
  const previous = [{ startDate: range.previous.start, endDate: range.previous.end }];
  const totals = [
    { dateRanges: current, metrics: metrics(TOTAL_METRICS) },
    { dateRanges: previous, metrics: metrics(TOTAL_METRICS) },
  ];
  if (scope === "summary") return { batches: [totals] };
  const dim = GRANULARITY_DIMENSION[granularity];
  const series = (dateRanges: typeof current) => ({
    dateRanges,
    dimensions: dims([dim]),
    metrics: metrics(SERIES_METRICS),
    orderBys: [{ dimension: { dimensionName: dim }, desc: false }],
    limit: 400,
  });
  return {
    batches: [
      [
        ...totals,
        series(current),
        series(previous),
        {
          dateRanges: current,
          dimensions: dims(["sessionDefaultChannelGroup"]),
          metrics: metrics(["sessions", "activeUsers", "engagementRate"]),
          orderBys: byMetricDesc("sessions"),
          limit: 20,
        },
      ],
      [
        {
          dateRanges: current,
          dimensions: dims(["sessionSource", "sessionMedium"]),
          metrics: metrics(["sessions", "activeUsers"]),
          orderBys: byMetricDesc("sessions"),
          limit: 25,
        },
        {
          dateRanges: current,
          dimensions: dims(["pagePath"]),
          metrics: metrics(["screenPageViews", "activeUsers"]),
          orderBys: byMetricDesc("screenPageViews"),
          limit: 20,
        },
        {
          dateRanges: current,
          dimensions: dims(["deviceCategory"]),
          metrics: metrics(["activeUsers", "sessions"]),
          orderBys: byMetricDesc("activeUsers"),
          limit: 10,
        },
        {
          dateRanges: current,
          dimensions: dims(["country"]),
          metrics: metrics(["activeUsers", "sessions"]),
          orderBys: byMetricDesc("activeUsers"),
          limit: 25,
        },
        {
          dateRanges: current,
          dimensions: dims(["region"]),
          metrics: metrics(["activeUsers", "sessions"]),
          dimensionFilter: {
            filter: { fieldName: "countryId", stringFilter: { matchType: "EXACT", value: "TR" } },
          },
          orderBys: byMetricDesc("activeUsers"),
          limit: 30,
        },
      ],
    ],
  };
}

/* ---- Yanıt → görünüm ---- */

export interface TrafficTotals {
  users: number;
  newUsers: number;
  sessions: number;
  pageViews: number;
  /** 0-1; oturum yoksa null. */
  engagementRate: number | null;
}

export interface TrafficSeriesPoint {
  key: string;
  current: { users: number; sessions: number; pageViews: number };
  /** Aynı sıradaki önceki dönem kovası; yoksa null. */
  previous: { users: number; sessions: number; pageViews: number } | null;
}

export interface TrafficBreakdownRow {
  label: string;
  /** İkinci boyut (ör. ortam); yoksa null. */
  detail: string | null;
  primary: number;
  secondary: number;
  /** Etkileşim oranı (yalnızca kanal raporu). */
  rate?: number | null;
}

export interface TrafficBreakdown {
  rows: TrafficBreakdownRow[];
  /** Küçük hücre kuralıyla "Diğer"e katılan satır sayısı. */
  suppressedRows: number;
}

export interface TrafficOverview {
  range: TrafficRange;
  granularity: TrafficGranularity;
  totals: { current: TrafficTotals; previous: TrafficTotals };
  series: TrafficSeriesPoint[];
  channels: TrafficBreakdown;
  sources: TrafficBreakdown;
  pages: TrafficBreakdown;
  devices: TrafficBreakdown;
  countries: TrafficBreakdown;
  regions: TrafficBreakdown;
}

export type TrafficSummary = Pick<TrafficOverview, "range" | "totals">;

function num(row: Ga4Row | undefined, index: number): number {
  const raw = row?.metricValues?.[index]?.value;
  const value = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function dim(row: Ga4Row, index: number): string {
  const value = row.dimensionValues?.[index]?.value ?? "";
  return value === "" || value === "(not set)" ? "(belirsiz)" : value;
}

export function parseTotals(report: Ga4Report | undefined): TrafficTotals {
  const row = report?.rows?.[0];
  const sessions = num(row, 2);
  return {
    users: num(row, 0),
    newUsers: num(row, 1),
    sessions,
    pageViews: num(row, 3),
    engagementRate: sessions > 0 ? num(row, 4) : null,
  };
}

function seriesMap(report: Ga4Report | undefined) {
  const map = new Map<string, { users: number; sessions: number; pageViews: number }>();
  for (const row of report?.rows ?? []) {
    map.set(row.dimensionValues?.[0]?.value ?? "", {
      users: num(row, 0),
      sessions: num(row, 1),
      pageViews: num(row, 2),
    });
  }
  return map;
}

export function parseSeries(
  range: TrafficRange,
  granularity: TrafficGranularity,
  currentReport: Ga4Report | undefined,
  previousReport: Ga4Report | undefined,
): TrafficSeriesPoint[] {
  const zero = { users: 0, sessions: 0, pageViews: 0 };
  const current = seriesMap(currentReport);
  const previous = seriesMap(previousReport);
  const previousKeys = bucketsOf(range.previous, granularity);
  return bucketsOf(range.current, granularity).map((key, index) => {
    const prevKey = previousKeys[index];
    return {
      key,
      current: current.get(key) ?? zero,
      previous: prevKey === undefined ? null : (previous.get(prevKey) ?? zero),
    };
  });
}

/**
 * Döküm. `suppress` verilirse birincil metriği (kullanıcı) eşiğin altındaki
 * satırlar tek "Diğer" satırında toplanır: tek kişiyi işaret eden şehir ya da
 * kaynak gösterilmez.
 */
export function parseBreakdown(
  report: Ga4Report | undefined,
  options: { twoDimensions?: boolean; suppressBelow?: number; rate?: boolean } = {},
): TrafficBreakdown {
  const rows: TrafficBreakdownRow[] = [];
  let other: TrafficBreakdownRow | null = null;
  let suppressedRows = 0;
  for (const row of report?.rows ?? []) {
    const item: TrafficBreakdownRow = {
      label: dim(row, 0),
      detail: options.twoDimensions ? dim(row, 1) : null,
      primary: num(row, 0),
      secondary: num(row, 1),
      ...(options.rate ? { rate: num(row, 2) } : {}),
    };
    const users = options.suppressBelow === undefined ? Infinity : usersOf(item, options);
    if (users < (options.suppressBelow ?? 0)) {
      suppressedRows += 1;
      other = other ?? { label: "Diğer", detail: null, primary: 0, secondary: 0 };
      other.primary += item.primary;
      other.secondary += item.secondary;
      continue;
    }
    rows.push(item);
  }
  if (other) rows.push(other);
  return { rows, suppressedRows };
}

/** Küçük hücre için kullanıcı sayısı: kaynakta ikinci, coğrafyada birinci metrik. */
function usersOf(item: TrafficBreakdownRow, options: { twoDimensions?: boolean }): number {
  return options.twoDimensions ? item.secondary : item.primary;
}

export function parseOverview(
  range: TrafficRange,
  granularity: TrafficGranularity,
  reports: readonly Ga4Report[],
): TrafficOverview {
  const [
    totalsNow,
    totalsPrev,
    seriesNow,
    seriesPrev,
    channels,
    sources,
    pages,
    devices,
    countries,
    regions,
  ] = reports;
  return {
    range,
    granularity,
    totals: { current: parseTotals(totalsNow), previous: parseTotals(totalsPrev) },
    series: parseSeries(range, granularity, seriesNow, seriesPrev),
    channels: parseBreakdown(channels, { rate: true }),
    sources: parseBreakdown(sources, {
      twoDimensions: true,
      suppressBelow: TRAFFIC_SMALL_CELL_MIN,
    }),
    pages: parseBreakdown(pages),
    devices: parseBreakdown(devices),
    countries: parseBreakdown(countries, { suppressBelow: TRAFFIC_SMALL_CELL_MIN }),
    regions: parseBreakdown(regions, { suppressBelow: TRAFFIC_SMALL_CELL_MIN }),
  };
}

export function parseSummary(range: TrafficRange, reports: readonly Ga4Report[]): TrafficSummary {
  return {
    range,
    totals: { current: parseTotals(reports[0]), previous: parseTotals(reports[1]) },
  };
}
