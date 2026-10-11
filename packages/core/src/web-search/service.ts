/**
 * Internet urun aramasi orkestrasyonu (docs/decisions/0102).
 *
 *   bayrak -> sorgu + metin suzgeci -> tek ucus kilidi -> gunluk butce ayirma
 *   -> kisi limiti -> Gemini (grounding + URL Context, tek deneme) -> atif
 *   adreslerini coz -> dogrula -> birlestir -> Search Suggestions kontrolu
 *
 * Google "Grounding with Google Search" kosullari geregi sonuclar ONBELLEKLENMEZ,
 * saklanmaz ve yalnizca istegi yapan kullaniciya, Search Suggestions ile birlikte
 * gosterilir. Bu yuzden burada sonuc onbellegi yoktur; maliyeti kisi limiti,
 * gunluk butce ve tek-ucus kilidi sinirlar. Kilit icerik tasimaz.
 *
 * ASLA firlatmaz: kapali bayrak, suzgec, limit, Redis/saglayici hatasi ya da
 * gecersiz cikti bir `WebSearchOutcome` durumuna donusur; cagiran veritabani
 * sonuclarini oldugu gibi gosterir. Log yalnizca sabit kod tasir; sorgu metni,
 * istem ya da ham yanit loglanmaz. Sonuclar KATALOGA YAZILMAZ; kalici tek iz
 * `api_usage` maliyet kayitlaridir (token ve grounding sorgusu ayri satir).
 */
import { createHash } from "node:crypto";
import { apiUsage, type Database } from "@arilla/db";
import { pseudonymize, SecretNotConfiguredError } from "../auth/token.ts";
import { type LlmCall, LlmError } from "../llm/client.ts";
import { groundingCostMicros, llmCallCostMicros } from "../llm/pricing.ts";
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
  WEB_SEARCH_DAILY_CALL_CAP,
  WEB_SEARCH_FLIGHT_TTL_MS,
  WEB_SEARCH_GROUNDING_OPERATION,
  WEB_SEARCH_MODEL,
  WEB_SEARCH_OPERATION,
} from "./config.ts";
import {
  getWebGroundingClient,
  resolveCitationMap,
  type WebGroundingClient,
} from "./grounding-client.ts";
import { mergeWebCandidates } from "./merge.ts";
import {
  buildGroundingEvidence,
  candidatesFromAnnotatedText,
  parseAndVerifyCandidates,
} from "./parse.ts";
import {
  buildWebSearchInput,
  buildWebSearchQuery,
  WEB_SEARCH_SYSTEM_INSTRUCTION,
  type WebQuerySource,
} from "./query.ts";
import { emptyWebOutcome, type WebSearchOutcome } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface WebSearchActor {
  userId: number | null;
  ip: string | null;
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
  limiter?: WebSearchLimiter;
  flight?: WebSearchFlight;
  budget?: ProviderBudgetHooks;
  now?: () => Date;
  dailyCallCap?: number;
}

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

/** Ayni sorgunun ayni anda ikinci kez odenmesini onleyen kilit anahtari (icerik yok). */
function flightKey(query: string, subject: string): string {
  return createHash("sha256").update(`${subject}\n${query}`).digest("hex").slice(0, 40);
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

/** Modelin YURUTTUGU benzersiz, bos olmayan arama sorgusu sayisi (grounding faturasi). */
export function countGroundingQueries(queries: readonly string[]): number {
  return new Set(queries.map((q) => q.trim().toLowerCase()).filter((q) => q.length > 0)).size;
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
  if (!built.ok) {
    console.warn("[web-search] ineligible query", built.reason);
    return emptyWebOutcome("ineligible");
  }
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

  const flight = deps.flight ?? redisFlight;
  const now = deps.now ?? (() => new Date());
  const subject = webSearchActorSubject(actor);
  const key = flightKey(query, subject);

  let flightHeld = false;
  try {
    try {
      flightHeld = await flight.acquire(key, WEB_SEARCH_FLIGHT_TTL_MS);
    } catch (error) {
      // Redis okunamazsa model cagrilmaz (maliyet kapali).
      if (!isRedisUnavailableError(error)) throw error;
      return emptyWebOutcome("unavailable");
    }
    // Ayni kisi ayni sorguyu ayni anda ikinci kez baslatti (yenileme, cift sekme).
    if (!flightHeld) return emptyWebOutcome("busy");

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
    let groundingQueries = 0;
    let outcome: WebSearchOutcome = emptyWebOutcome("error");
    try {
      try {
        const allowed = await (deps.limiter ?? redisLimiter).allow(subject, now());
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
        groundingQueries = countGroundingQueries(grounded.searchQueries);
        const resolvedMap = await resolveCitationMap(grounded.citations, deps.fetch ?? fetch);
        const citationUrls = [...new Set([...resolvedMap.values()].filter((u) => u !== null))];
        const evidence = buildGroundingEvidence(citationUrls, grounded.retrieved);
        const parsed = parseAndVerifyCandidates(grounded.text, evidence);
        const stats = parsed.stats;
        const candidates =
          parsed.candidates.length > 0
            ? parsed.candidates
            : candidatesFromAnnotatedText(grounded.text, grounded.citations, resolvedMap);
        const groups = mergeWebCandidates({ candidates, query, features });
        if (groups.length === 0 || grounded.searchSuggestionsHtml === null) {
          // Tanilama (icerik yok): sessiz bos sonucun nedeni gunluklerde gorunsun.
          console.warn(
            `[web-search] diag candidates=${stats.received} rejected=${stats.rejected}`,
            JSON.stringify(stats.reasons),
            `citations=${grounded.citations.length} resolved=${citationUrls.length}`,
            `retrieved=${grounded.retrieved.filter((r) => r.ok).length}/${grounded.retrieved.length}`,
            `queries=${grounded.searchQueries.length} groups=${groups.length}`,
            `suggestions=${grounded.searchSuggestionsHtml !== null} textLen=${grounded.text.length}`,
            grounded.shape ?? "",
          );
        }
        if (groups.length > 0 && grounded.searchSuggestionsHtml === null) {
          // Google kosulu: grounding sonuclari Search Suggestions olmadan gosterilmez.
          console.warn("[web-search] search suggestions missing; results withheld");
          outcome = emptyWebOutcome("empty");
        } else {
          outcome = {
            status: groups.length > 0 ? "ok" : "empty",
            groups,
            searchSuggestionsHtml: groups.length > 0 ? grounded.searchSuggestionsHtml : null,
          };
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
      const at = now();
      const rows = calls.map((call) => ({
        sessionId: null,
        userId: actor.userId,
        operation: WEB_SEARCH_OPERATION,
        modelVersion: call.modelVersion || WEB_SEARCH_MODEL,
        units: call.usage?.totalTokens ?? 0,
        // Karar 0102: token ucreti (kural yoksa/kur yoksa "fiyatlanmamis" = 0).
        costMicros: llmCallCostMicros(call, at),
        cacheHit: false,
      }));
      if (groundingQueries > 0) {
        // Grounding sorgu ucreti token ucretinden AYRI satir: units = sorgu sayisi.
        rows.push({
          sessionId: null,
          userId: actor.userId,
          operation: WEB_SEARCH_GROUNDING_OPERATION,
          modelVersion: WEB_SEARCH_MODEL,
          units: groundingQueries,
          costMicros: groundingCostMicros(groundingQueries, at),
          cacheHit: false,
        });
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await db.insert(apiUsage).values(rows);
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
