/**
 * Yönetim analitik raporları (docs/decisions/0116). Rapor tanımları kodda sabit ve
 * yalnızca belgeden DOĞRULANMIŞ uç noktaları/tipleri kullanır:
 * `stats`, `pageviews`, `metrics?type=`. Kullanıcı girdisi yalnızca doğrulanmış
 * tarih aralığı ve güvenli `utmCampaign` etiketidir.
 *
 * Hata izolasyonu: her bölüm bağımsızdır (`Promise.allSettled`); bir bölüm
 * düşerse diğerleri görünür. Redis önbelleği: tamamlanmış aralık 6 saat, bugünü
 * içeren 5 dk; son iyi veri 7 gün tutulur ve hata/zaman aşımında "eski" diye
 * döner. Redis yoksa doğrudan Umami'ye gidilir; ikisi de düşerse bölüm hata
 * türüyle döner. Bu modül yönlendirme ya da sayfa yolundan ÇAĞRILMAZ.
 */
import { createHash } from "node:crypto";
import { getRedis } from "../redis/client.ts";
import { istanbulToday, type StatsRange } from "../tracking-links/admin.ts";
import { LABEL_PATTERN } from "../tracking-links/policy.ts";
import type { CacheClient } from "../tracking-links/redirect.ts";
import { type FetchLike, UmamiError, type UmamiErrorKind, umamiGet } from "./client.ts";
import type { UmamiApiConfig } from "./config.ts";

/** Doğrulanmış `metrics?type=` değerleri (docs.umami.is get-website-metrics). */
export const METRIC_TYPES = [
  "referrer",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "country",
  "device",
  "browser",
  "os",
  "path",
  "event",
] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export const METRIC_ROW_LIMIT = 10;
const TIME_ZONE = "Europe/Istanbul";
export const FRESH_TTL_COMPLETED = 6 * 60 * 60;
export const FRESH_TTL_TODAY = 5 * 60;
export const LAST_GOOD_TTL = 7 * 24 * 60 * 60;

export interface ReportFilters {
  /** Yalnızca `LABEL_PATTERN`'e uyan kampanya etiketi (kısa bağlantının `campaign`'i). */
  utmCampaign?: string;
}

export function validateFilters(filters: ReportFilters): ReportFilters {
  if (filters.utmCampaign !== undefined && !LABEL_PATTERN.test(filters.utmCampaign)) {
    throw new UmamiError("invalid_response"); // çağıran hatası: güvenli olmayan süzgeç asla gönderilmez
  }
  return filters.utmCampaign !== undefined ? { utmCampaign: filters.utmCampaign } : {};
}

// --- Biçim doğrulama ---------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface OverviewTotals {
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  /** Toplam ziyaret süresi (saniye). */
  totaltime: number;
}

export interface Overview extends OverviewTotals {
  comparison: OverviewTotals | null;
}

function totals(value: unknown): OverviewTotals {
  if (
    !isRecord(value) ||
    !isNum(value.visitors) ||
    !isNum(value.visits) ||
    !isNum(value.pageviews) ||
    !isNum(value.bounces) ||
    !isNum(value.totaltime)
  ) {
    throw new UmamiError("invalid_response");
  }
  return {
    visitors: value.visitors,
    visits: value.visits,
    pageviews: value.pageviews,
    bounces: value.bounces,
    totaltime: value.totaltime,
  };
}

export function parseUmamiOverview(raw: unknown): Overview {
  const base = totals(raw);
  const comparison = isRecord(raw) && isRecord(raw.comparison) ? raw.comparison : null;
  let compare: OverviewTotals | null = null;
  if (comparison) {
    try {
      compare = totals(comparison);
    } catch {
      compare = null; // karşılaştırma alanları eksikse yalnızca karşılaştırma düşer
    }
  }
  return { ...base, comparison: compare };
}

export interface SeriesPoint {
  /** Umami'nin döndürdüğü zaman dilimi etiketi (en fazla 32 karakter). */
  label: string;
  pageviews: number;
  sessions: number;
}

function points(value: unknown): Map<string, number> {
  if (!Array.isArray(value)) throw new UmamiError("invalid_response");
  const out = new Map<string, number>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.x !== "string" || !isNum(item.y)) {
      throw new UmamiError("invalid_response");
    }
    out.set(item.x.slice(0, 32), item.y);
  }
  return out;
}

export function parseUmamiSeries(raw: unknown): SeriesPoint[] {
  if (!isRecord(raw)) throw new UmamiError("invalid_response");
  const views = points(raw.pageviews);
  const sessions = points(raw.sessions);
  const labels = [...new Set([...views.keys(), ...sessions.keys()])].sort();
  return labels.map((label) => ({
    label,
    pageviews: views.get(label) ?? 0,
    sessions: sessions.get(label) ?? 0,
  }));
}

export interface MetricRow {
  label: string;
  value: number;
}

export function parseUmamiMetric(raw: unknown): MetricRow[] {
  if (!Array.isArray(raw)) throw new UmamiError("invalid_response");
  return raw.slice(0, METRIC_ROW_LIMIT).map((item) => {
    if (!isRecord(item) || !isNum(item.y) || !(item.x === null || typeof item.x === "string")) {
      throw new UmamiError("invalid_response");
    }
    return { label: (item.x ?? "").slice(0, 200), value: item.y };
  });
}

// --- Aralık ------------------------------------------------------------------

/** Europe/Istanbul gün sınırları (Türkiye kalıcı UTC+3). `endAt` dahil günün sonu. */
export function rangeQuery(range: StatsRange): {
  startAt: number;
  endAt: number;
  timezone: string;
  unit: "hour" | "day";
} {
  return {
    startAt: Date.parse(`${range.from}T00:00:00+03:00`),
    endAt: Date.parse(`${range.to}T23:59:59.999+03:00`),
    timezone: TIME_ZONE,
    unit: range.days <= 2 ? "hour" : "day",
  };
}

// --- Önbellek ----------------------------------------------------------------

export interface Cached<T> {
  data: T;
  /** Umami yanıt vermediği için son iyi veri gösteriliyor. */
  stale: boolean;
  /** Son iyi verinin yazıldığı an (yalnızca eski veride). */
  storedAt: number | null;
}

function cacheKey(kind: string, parts: Record<string, string | number>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([kind, parts]))
    .digest("hex");
  return `umami:v1:${kind}:${digest.slice(0, 32)}`;
}

function defaultCache(): CacheClient {
  return getRedis() as unknown as CacheClient;
}

async function cached<T>(
  key: string,
  freshTtl: number,
  loader: () => Promise<T>,
  cache: CacheClient | null | undefined,
  now: () => number,
): Promise<Cached<T>> {
  let client: CacheClient | null = cache ?? null;
  if (cache === undefined) {
    try {
      client = defaultCache();
    } catch {
      client = null;
    }
  }
  if (client) {
    try {
      const hit = await client.get(`${key}:fresh`);
      if (hit !== null) return { data: JSON.parse(hit) as T, stale: false, storedAt: null };
    } catch {
      // önbellek okunamadı: doğrudan Umami
    }
  }
  try {
    const data = await loader();
    if (client) {
      try {
        const body = JSON.stringify(data);
        await client.set(`${key}:fresh`, body, "EX", freshTtl);
        await client.set(`${key}:good`, JSON.stringify({ at: now(), data }), "EX", LAST_GOOD_TTL);
      } catch {
        // yazılamadı: sorun değil
      }
    }
    return { data, stale: false, storedAt: null };
  } catch (error) {
    if (client) {
      try {
        const good = await client.get(`${key}:good`);
        if (good !== null) {
          const parsed = JSON.parse(good) as { at: number; data: T };
          return { data: parsed.data, stale: true, storedAt: parsed.at };
        }
      } catch {
        // son iyi veri de yok
      }
    }
    throw error;
  }
}

// --- Rapor -------------------------------------------------------------------

export interface ReportDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** `undefined`: paylaşılan Redis; `null`: önbellek kapalı (testler). */
  cache?: CacheClient | null;
  now?: () => number;
  today?: string;
}

export type Section<T> =
  | { ok: true; value: T; stale: boolean; storedAt: number | null }
  | { ok: false; error: UmamiErrorKind };

export interface AnalyticsReport {
  range: StatsRange;
  filters: ReportFilters;
  overview: Section<Overview>;
  /** İstenmediyse `null` (kampanya özeti gibi hafif çağrılar). */
  series: Section<SeriesPoint[]> | null;
  /** Yalnızca istenen tipler. */
  metrics: Partial<Record<MetricType, Section<MetricRow[]>>>;
}

export interface ReportScope {
  series: boolean;
  metrics: readonly MetricType[];
}

export const FULL_SCOPE: ReportScope = { series: true, metrics: METRIC_TYPES };

function asSection<T>(result: PromiseSettledResult<Cached<T>>): Section<T> {
  if (result.status === "fulfilled") {
    return {
      ok: true,
      value: result.value.data,
      stale: result.value.stale,
      storedAt: result.value.storedAt,
    };
  }
  const reason = result.reason;
  return { ok: false, error: reason instanceof UmamiError ? reason.kind : "network" };
}

export async function fetchAnalyticsReport(
  config: UmamiApiConfig,
  range: StatsRange,
  rawFilters: ReportFilters = {},
  deps: ReportDeps = {},
  scope: ReportScope = FULL_SCOPE,
): Promise<AnalyticsReport> {
  const filters = validateFilters(rawFilters);
  const now = deps.now ?? Date.now;
  const today = deps.today ?? istanbulToday(new Date(now()));
  const ttl = range.to >= today ? FRESH_TTL_TODAY : FRESH_TTL_COMPLETED;
  const cache = deps.cache; // undefined: varsayılan Redis; null: önbellek kapalı
  const base = { ...rangeQuery(range), ...filters };
  const request = { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs };
  const cacheScope = { site: config.websiteId, from: range.from, to: range.to, ...filters };

  const run = <T>(kind: string, extra: Record<string, string | number>, loader: () => Promise<T>) =>
    cached(cacheKey(kind, { ...cacheScope, ...extra }), ttl, loader, cache, now);

  const overviewP = run("overview", {}, async () =>
    parseUmamiOverview(await umamiGet(config, "/stats", { ...base, compare: "prev" }, request)),
  );
  const seriesP = scope.series
    ? run("series", { unit: base.unit }, async () =>
        parseUmamiSeries(await umamiGet(config, "/pageviews", base, request)),
      )
    : Promise.resolve(null);
  const metricPs = scope.metrics.map((type) =>
    run("metric", { type }, async () =>
      parseUmamiMetric(
        await umamiGet(config, "/metrics", { ...base, type, limit: METRIC_ROW_LIMIT }, request),
      ),
    ),
  );

  const [overview, series, ...metricResults] = await Promise.allSettled([
    overviewP,
    seriesP,
    ...metricPs,
  ]);
  const metrics: Partial<Record<MetricType, Section<MetricRow[]>>> = {};
  scope.metrics.forEach((type, index) => {
    metrics[type] = asSection(metricResults[index] as PromiseSettledResult<Cached<MetricRow[]>>);
  });
  return {
    range,
    filters,
    overview: asSection(overview as PromiseSettledResult<Cached<Overview>>),
    series: scope.series ? asSection(series as PromiseSettledResult<Cached<SeriesPoint[]>>) : null,
    metrics,
  };
}
