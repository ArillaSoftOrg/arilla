/**
 * Internet urun aramasi orkestrasyonu (docs/decisions/0101).
 *
 *   bayrak -> sorgu + metin suzgeci -> Redis onbellek -> tek ucus kilidi
 *   -> gunluk butce ayirma -> kisi limiti -> Gemini (grounding + URL Context,
 *   tek deneme) -> atif adreslerini coz -> dogrula -> birlestir -> onbellege yaz
 *
 * ASLA firlatmaz: kapali bayrak, suzgec, limit, Redis/saglayici hatasi ya da
 * gecersiz cikti bir `WebSearchOutcome` durumuna donusur; cagiran veritabani
 * sonuclarini oldugu gibi gosterir. Log yalnizca sabit kod tasir; sorgu metni,
 * istem ya da ham yanit loglanmaz. Sonuclar KATALOGA YAZILMAZ: yalnizca
 * Redis onbellegi (<= 6 saat) ve `api_usage` maliyet kaydi.
 */
import { createHash } from "node:crypto";
import { apiUsage, type Database } from "@arilla/db";
import { pseudonymize, SecretNotConfiguredError } from "../auth/token.ts";
import { type LlmCall, LlmError } from "../llm/client.ts";
import { llmCallCostMicros } from "../llm/pricing.ts";
import {
  type ProviderBudgetHooks,
  type ProviderBudgetReservation,
  reserveProviderBudget,
  settleProviderBudget,
} from "../quota/provider-budget.ts";
import { getRedis, isRedisUnavailableError } from "../redis/client.ts";
import {
  isWebSearchEnabled,
  WEB_SEARCH_ACTOR_LIMITS,
  WEB_SEARCH_BUDGET_KEY,
  WEB_SEARCH_CACHE_TTL_SECONDS,
  WEB_SEARCH_DAILY_CALL_CAP,
  WEB_SEARCH_EMPTY_CACHE_TTL_SECONDS,
  WEB_SEARCH_FLIGHT_TTL_MS,
  WEB_SEARCH_MODEL,
  WEB_SEARCH_OPERATION,
} from "./config.ts";
import {
  getWebGroundingClient,
  resolveCitationUrls,
  type WebGroundingClient,
} from "./grounding-client.ts";
import { mergeWebCandidates } from "./merge.ts";
import { buildGroundingEvidence, parseAndVerifyCandidates } from "./parse.ts";
import {
  buildWebSearchInput,
  buildWebSearchQuery,
  WEB_SEARCH_SYSTEM_INSTRUCTION,
  type WebQuerySource,
} from "./query.ts";
import { emptyWebOutcome, type WebProductGroup, type WebSearchOutcome } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface WebSearchActor {
  userId: number | null;
  ip: string | null;
}

export interface WebSearchCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface WebSearchLimiter {
  /** Gercek model cagrisindan ONCE; `false` = limit doldu. */
  allow(subject: string, now: Date): Promise<boolean>;
}

export interface WebSearchFlight {
  acquire(key: string, ttlMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface WebSearchDeps {
  env?: Env;
  /** Testler icin; verilirse bayrak kontrolu atlanir (realtime-interpretation ile ayni desen). */
  client?: WebGroundingClient | null;
  fetch?: typeof fetch;
  cache?: WebSearchCache;
  limiter?: WebSearchLimiter;
  flight?: WebSearchFlight;
  budget?: ProviderBudgetHooks;
  now?: () => Date;
  dailyCallCap?: number;
  sleep?: (ms: number) => Promise<void>;
}

const redisCache: WebSearchCache = {
  async get(key) {
    return getRedis().get(key);
  },
  async set(key, value, ttlSeconds) {
    await getRedis().set(key, value, "EX", ttlSeconds);
  },
};

const redisFlight: WebSearchFlight = {
  async acquire(key, ttlMs) {
    return (await getRedis().set(`wsf:${key}`, "1", "PX", ttlMs, "NX")) === "OK";
  },
  async release(key) {
    await getRedis().del(`wsf:${key}`);
  },
};

const redisLimiter: WebSearchLimiter = {
  async allow(subject, now) {
    const redis = getRedis();
    const hourKey = `websearch:actor:${subject}:h:${Math.floor(now.getTime() / 3_600_000)}`;
    const dayKey = `websearch:actor:${subject}:d:${Math.floor(now.getTime() / 86_400_000)}`;
    const results = await redis
      .multi()
      .incr(hourKey)
      .expire(hourKey, 2 * 3_600)
      .incr(dayKey)
      .expire(dayKey, 2 * 86_400)
      .exec();
    const hour = Number(results?.[0]?.[1]);
    const day = Number(results?.[2]?.[1]);
    if (!Number.isFinite(hour) || !Number.isFinite(day)) {
      throw new Error("web search limiter: bad reply");
    }
    return hour <= WEB_SEARCH_ACTOR_LIMITS.hour && day <= WEB_SEARCH_ACTOR_LIMITS.day;
  },
};

export function webSearchActorSubject(actor: WebSearchActor): string {
  if (actor.userId !== null) return `user:${actor.userId}`;
  return actor.ip ? `ip:${pseudonymize("websearch", actor.ip.trim())}` : "ip:unknown";
}

function logFailure(stage: string, error: unknown): void {
  const code =
    (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code ??
    (error as { code?: unknown } | null)?.code;
  console.warn(
    `[web-search] ${stage} failed`,
    error instanceof Error ? error.name : "unknown",
    typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "",
  );
}

function cacheKey(query: string): string {
  return `websearch:v1:${createHash("sha256").update(query).digest("hex").slice(0, 40)}`;
}

function readCached(raw: string | null): WebProductGroup[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WebProductGroup[]) : null;
  } catch {
    return null;
  }
}

function outcomeFromGroups(groups: WebProductGroup[], cached: boolean): WebSearchOutcome {
  return { status: groups.length > 0 ? "ok" : "empty", groups, cached };
}

export async function searchWeb(
  db: Database,
  source: WebQuerySource,
  actor: WebSearchActor,
  deps: WebSearchDeps = {},
): Promise<WebSearchOutcome> {
  try {
    return await run(db, source, actor, deps);
  } catch (error) {
    logFailure("unexpected", error);
    return emptyWebOutcome("error");
  }
}

async function run(
  db: Database,
  source: WebQuerySource,
  actor: WebSearchActor,
  deps: WebSearchDeps,
): Promise<WebSearchOutcome> {
  const env = deps.env ?? process.env;
  if (deps.client === undefined && !isWebSearchEnabled(env)) return emptyWebOutcome("disabled");

  // Saglayiciya gidecek tek sey: suzgecten gecmis urun terimleri.
  const built = buildWebSearchQuery(source);
  if (!built.ok) return emptyWebOutcome("ineligible");
  const { query, features } = built;

  let client: WebGroundingClient | null;
  if (deps.client !== undefined) {
    client = deps.client;
  } else {
    try {
      client = getWebGroundingClient(env, deps.fetch ? { fetch: deps.fetch } : {});
    } catch (error) {
      if (error instanceof LlmError) return emptyWebOutcome("disabled");
      logFailure("client", error);
      return emptyWebOutcome("error");
    }
  }
  if (client === null) return emptyWebOutcome("disabled");

  const cache = deps.cache ?? redisCache;
  const flight = deps.flight ?? redisFlight;
  const key = cacheKey(query);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let flightHeld = false;
  try {
    // Onbellek: ayni sorgu icin ikinci odeme yok. Redis yoksa model cagrilmaz (maliyet kapali).
    try {
      const hit = readCached(await cache.get(key));
      if (hit !== null) return outcomeFromGroups(hit, true);
    } catch (error) {
      if (!isRedisUnavailableError(error)) throw error;
      logFailure("cache read", error);
      return emptyWebOutcome("unavailable");
    }

    try {
      flightHeld = await flight.acquire(key, WEB_SEARCH_FLIGHT_TTL_MS);
    } catch (error) {
      if (!isRedisUnavailableError(error)) throw error;
      return emptyWebOutcome("unavailable");
    }
    if (!flightHeld) {
      // Ayni sorgu baska istekte araniyor: sonucu kisa sure bekle, ikinci cagri yok.
      for (let i = 0; i < 4; i++) {
        await sleep(1_500);
        try {
          const hit = readCached(await cache.get(key));
          if (hit !== null) return outcomeFromGroups(hit, true);
        } catch {
          break;
        }
      }
      return emptyWebOutcome("busy");
    }

    const cap = Math.min(
      Math.max(0, deps.dailyCallCap ?? WEB_SEARCH_DAILY_CALL_CAP),
      WEB_SEARCH_DAILY_CALL_CAP,
    );
    let reservation: ProviderBudgetReservation;
    try {
      const budget = await (deps.budget?.reserve ?? reserveProviderBudget)({
        operation: WEB_SEARCH_BUDGET_KEY,
        amount: 1,
        cap,
        now: now(),
      });
      if (!budget.allowed) return emptyWebOutcome("limited");
      reservation = budget.reservation;
    } catch (error) {
      if (!isRedisUnavailableError(error)) throw error;
      logFailure("provider budget", error);
      return emptyWebOutcome("unavailable");
    }

    let attempts: number | null = 0;
    const calls: LlmCall[] = [];
    let outcome: WebSearchOutcome = emptyWebOutcome("error");
    try {
      try {
        const allowed = await (deps.limiter ?? redisLimiter).allow(
          webSearchActorSubject(actor),
          now(),
        );
        if (!allowed) return emptyWebOutcome("limited");
      } catch (error) {
        // Limit dogrulanamazsa model cagrilmaz (fail-closed).
        if (!isRedisUnavailableError(error) && !(error instanceof SecretNotConfiguredError)) {
          logFailure("actor limit", error);
        }
        return emptyWebOutcome("limited");
      }

      attempts = null;
      let grounded: Awaited<ReturnType<WebGroundingClient["search"]>> | null = null;
      try {
        grounded = await client.search(
          { systemInstruction: WEB_SEARCH_SYSTEM_INSTRUCTION, input: buildWebSearchInput(query) },
          { onCall: (call) => calls.push(call) },
        );
      } catch (error) {
        logFailure("provider", error);
        outcome = emptyWebOutcome(
          error instanceof LlmError && error.code === "rate_limited" ? "limited" : "error",
        );
      }
      attempts = calls.length;

      if (grounded !== null) {
        const citationUrls = await resolveCitationUrls(grounded.citations, deps.fetch ?? fetch);
        const evidence = buildGroundingEvidence(citationUrls, grounded.retrieved);
        const { candidates } = parseAndVerifyCandidates(grounded.text, evidence);
        const groups = mergeWebCandidates({ candidates, query, features });
        outcome = outcomeFromGroups(groups, false);
        try {
          await cache.set(
            key,
            JSON.stringify(groups),
            groups.length > 0 ? WEB_SEARCH_CACHE_TTL_SECONDS : WEB_SEARCH_EMPTY_CACHE_TTL_SECONDS,
          );
        } catch (error) {
          logFailure("cache write", error);
        }
      }
    } finally {
      if (attempts !== null) {
        await (deps.budget?.settle ?? settleProviderBudget)(reservation, attempts).catch(
          (error: unknown) => logFailure("provider budget settle", error),
        );
      }
    }

    // Kural 9: ucret olustu; gecici DB hatasi izi kaybettirmesin, bir kez daha dener.
    if (calls.length > 0) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await db.insert(apiUsage).values(
            calls.map((call) => ({
              sessionId: null,
              userId: actor.userId,
              operation: WEB_SEARCH_OPERATION,
              modelVersion: call.modelVersion || WEB_SEARCH_MODEL,
              units: call.usage?.totalTokens ?? 0,
              // Karar 0082/0101: fiyat kurali yoksa "fiyatlanmamis" (0); uydurma tutar yok.
              costMicros: llmCallCostMicros(call),
              cacheHit: false,
            })),
          );
          break;
        } catch (error) {
          if (attempt === 2) logFailure("persist usage", error);
        }
      }
    }
    return outcome;
  } finally {
    if (flightHeld) await flight.release(key).catch(() => undefined);
  }
}
