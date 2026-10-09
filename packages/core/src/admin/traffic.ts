/**
 * `/yonetim/trafik` ve genel bakış trafik özeti (karar 0087, `traffic.read`).
 *
 * Kaynak GA4 Data API: RIZALI ÖRNEKLEM. Analitik çerezine izin vermeyen
 * ziyaretçi sayılmaz; sayılar sitenin tüm trafiği değildir ve arayüz bunu
 * etiketler. Model ya da tahmin yok: GA4 ne döndürürse o (eksik kova 0).
 *
 * Önbellek (Redis): tamamlanmış aralık 6 saat, bugünü içeren 15 dk; son iyi
 * yanıt 7 gün ayrıca tutulur ve hata/kota durumunda "eski veri" olarak
 * gösterilir. Aynı anahtar için süreç içinde tek istek (single-flight).
 * `propertyQuota` kalanları eşiğin altındaysa yeni istek atılmaz.
 */
import { createHash } from "node:crypto";
import { type Ga4ApiConfigResult, ga4ApiConfigFromEnv } from "../analytics-ga4/config.ts";
import {
  batchRunReports,
  clearGa4TokenCache,
  Ga4ApiError,
  type Ga4ErrorCode,
  type Ga4QuotaSnapshot,
  type Ga4Report,
  type Ga4Transport,
  quotaSnapshot,
} from "../analytics-ga4/data-api.ts";
import {
  istanbulDate,
  parseOverview,
  parseSummary,
  type TrafficGranularity,
  type TrafficOverview,
  type TrafficRange,
  type TrafficScope,
  type TrafficSummary,
  trafficRequests,
} from "../analytics-ga4/reports.ts";
import { getRedis } from "../redis/client.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

/** Önbellek deposu: üretimde Redis, testte bellek. Hata fırlatabilir; çağıran yutar. */
export interface TrafficCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/**
 * Üretim deposu: paylaşılan Redis istemcisi (komut ve bağlantı zaman aşımlı).
 * Redis yoksa ya da yapılandırılmamışsa hata, `safeGet/safeSet` ile yutulur.
 */
export function redisTrafficCacheStore(): TrafficCacheStore {
  return {
    async get(key) {
      return getRedis().get(key);
    },
    async set(key, value, ttlSeconds) {
      await getRedis().set(key, value, "EX", ttlSeconds);
    },
  };
}

export interface TrafficDeps {
  env?: Readonly<Record<string, string | undefined>>;
  transport?: Ga4Transport;
  store?: TrafficCacheStore | null;
  now?: () => Date;
}

const CACHE_VERSION = "v1";
const FRESH_TTL_COMPLETE_S = 6 * 60 * 60;
const FRESH_TTL_TODAY_S = 15 * 60;
const STALE_TTL_S = 7 * 24 * 60 * 60;
const QUOTA_TTL_S = 60 * 60;

/** Bu kalanların altında yeni Data API isteği atılmaz (bir tam görünüm ~10 rapor). */
export const TRAFFIC_QUOTA_FLOOR = {
  projectHour: 1_500,
  hour: 3_000,
  day: 10_000,
} as const;

export type TrafficErrorCode = Ga4ErrorCode | "quota_guard";

export type TrafficConfigState =
  | { state: "not_configured"; missing: string[] }
  | { state: "invalid_config"; problems: string[] };

export type TrafficResult<T> =
  | TrafficConfigState
  | { state: "ok"; data: T; fetchedAt: Date; cached: boolean; testEndpoint: boolean }
  | {
      state: "stale";
      data: T;
      fetchedAt: Date;
      error: TrafficErrorCode;
      testEndpoint: boolean;
    }
  | { state: "error"; error: TrafficErrorCode };

const inflight = new Map<string, Promise<unknown>>();

function cacheKey(propertyId: string, kind: string, parts: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  // Mülk kimliği anahtarda özetlenir: Redis'te açık yazılmaz.
  const property = createHash("sha256").update(propertyId).digest("hex").slice(0, 12);
  return `ga4:${CACHE_VERSION}:${property}:${kind}:${digest}`;
}

function quotaKey(propertyId: string): string {
  const property = createHash("sha256").update(propertyId).digest("hex").slice(0, 12);
  return `ga4:${CACHE_VERSION}:${property}:quota`;
}

async function safeGet(store: TrafficCacheStore | null, key: string): Promise<string | null> {
  if (!store) return null;
  try {
    return await store.get(key);
  } catch {
    return null;
  }
}

async function safeSet(store: TrafficCacheStore | null, key: string, value: string, ttl: number) {
  if (!store) return;
  try {
    await store.set(key, value, ttl);
  } catch {
    // Önbellek yazılamazsa görünüm yine döner; bir sonraki istek yeniden çeker.
  }
}

/** Tarihleri JSON'dan geri kazandırır (yalnızca `fetchedAt` zarfında). */
interface Envelope<T> {
  data: T;
  fetchedAt: string;
}

function quotaTooLow(snapshot: Ga4QuotaSnapshot | null): boolean {
  if (!snapshot) return false;
  const below = (value: number | null, floor: number) => value !== null && value < floor;
  return (
    below(snapshot.projectHourRemaining, TRAFFIC_QUOTA_FLOOR.projectHour) ||
    below(snapshot.hourRemaining, TRAFFIC_QUOTA_FLOOR.hour) ||
    below(snapshot.dayRemaining, TRAFFIC_QUOTA_FLOOR.day)
  );
}

function defaultTransport(): Ga4Transport {
  return { fetch: globalThis.fetch.bind(globalThis), now: () => Date.now() };
}

function configState(result: Ga4ApiConfigResult): TrafficConfigState | null {
  if (result.status === "not_configured")
    return { state: "not_configured", missing: result.missing };
  if (result.status === "invalid") return { state: "invalid_config", problems: result.problems };
  return null;
}

async function cachedReports<T>(
  kind: string,
  parts: { range: TrafficRange; granularity?: TrafficGranularity },
  batches: Record<string, unknown>[][],
  build: (reports: Ga4Report[]) => T,
  deps: TrafficDeps,
): Promise<TrafficResult<T>> {
  const config = ga4ApiConfigFromEnv(deps.env ?? process.env);
  const notReady = configState(config);
  if (notReady || config.status !== "ready") return notReady as TrafficConfigState;
  const { propertyId, testEndpoint } = config.config;
  const store = deps.store === undefined ? null : deps.store;
  const now = deps.now ?? (() => new Date());
  const key = cacheKey(propertyId, kind, parts);
  const staleKey = `${key}:stale`;

  const fresh = await safeGet(store, key);
  if (fresh) {
    const envelope = JSON.parse(fresh) as Envelope<T>;
    return {
      state: "ok",
      data: envelope.data,
      fetchedAt: new Date(envelope.fetchedAt),
      cached: true,
      testEndpoint,
    };
  }

  const fallback = async (error: TrafficErrorCode): Promise<TrafficResult<T>> => {
    const stale = await safeGet(store, staleKey);
    if (!stale) return { state: "error", error };
    const envelope = JSON.parse(stale) as Envelope<T>;
    return {
      state: "stale",
      data: envelope.data,
      fetchedAt: new Date(envelope.fetchedAt),
      error,
      testEndpoint,
    };
  };

  const quotaRaw = await safeGet(store, quotaKey(propertyId));
  if (quotaTooLow(quotaRaw ? (JSON.parse(quotaRaw) as Ga4QuotaSnapshot) : null)) {
    return fallback("quota_guard");
  }

  const pending =
    (inflight.get(key) as Promise<Ga4Report[]> | undefined) ??
    (async () => {
      const transport = deps.transport ?? defaultTransport();
      const reports: Ga4Report[] = [];
      // Sırayla: eşzamanlı istek kotası (mülk başına 10) zorlanmaz.
      for (const batch of batches) {
        reports.push(...(await batchRunReports(config.config, transport, batch)));
      }
      return reports;
    })();
  inflight.set(key, pending);
  let reports: Ga4Report[];
  try {
    reports = await pending;
  } catch (error) {
    if (error instanceof Ga4ApiError) {
      // Yetki/kimlik hatasında bellekteki belirteç bir daha kullanılmaz.
      if (error.code === "auth" || error.code === "permission") clearGa4TokenCache();
      return fallback(error.code);
    }
    throw error;
  } finally {
    inflight.delete(key);
  }

  const data = build(reports);
  const fetchedAt = now();
  const includesToday = parts.range.current.end >= istanbulDate(fetchedAt);
  const envelope = JSON.stringify({
    data,
    fetchedAt: fetchedAt.toISOString(),
  } satisfies Envelope<T>);
  await safeSet(store, key, envelope, includesToday ? FRESH_TTL_TODAY_S : FRESH_TTL_COMPLETE_S);
  await safeSet(store, staleKey, envelope, STALE_TTL_S);
  await safeSet(store, quotaKey(propertyId), JSON.stringify(quotaSnapshot(reports)), QUOTA_TTL_S);
  return { state: "ok", data, fetchedAt, cached: false, testEndpoint };
}

export async function getTrafficOverview(
  actor: AdminActor,
  input: { range: TrafficRange; granularity: TrafficGranularity },
  deps: TrafficDeps = {},
): Promise<TrafficResult<TrafficOverview>> {
  assertCapability(actor, "traffic.read");
  const scope: TrafficScope = "full";
  return cachedReports(
    "overview",
    input,
    trafficRequests(input.range, input.granularity, scope).batches,
    (reports) => parseOverview(input.range, input.granularity, reports),
    deps,
  );
}

/** Genel bakış: yalnızca toplamlar (2 rapor, tek istek). */
export async function getTrafficSummary(
  actor: AdminActor,
  input: { range: TrafficRange },
  deps: TrafficDeps = {},
): Promise<TrafficResult<TrafficSummary>> {
  assertCapability(actor, "traffic.read");
  return cachedReports(
    "summary",
    { range: input.range },
    trafficRequests(input.range, "gun", "summary").batches,
    (reports) => parseSummary(input.range, reports),
    deps,
  );
}

/** Yapılandırma durumu (ağ çağrısı yok): sayfa ve ayarlar için. */
export function trafficConfigStatus(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "ready" | "not_configured" | "invalid" {
  return ga4ApiConfigFromEnv(env).status;
}
