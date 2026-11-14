/**
 * `/ara` anlik IntentV2 niyeti (docs/decisions/0171 Faz 2; 0062 istisnasinin
 * AYNI cagrisi, yalnizca sema IntentV2). Istek yolunda:
 *
 *   bayrak -> metin suzgeci -> saklanan ham cikti (varsa yeniden dogrula)
 *   -> yerel analiz + yonlendirme (yeterliyse cagri yok) -> tek-ucus kilidi
 *   -> gunluk tavan -> kisi basina kota -> Gemini (2,5 sn, tek deneme)
 *   -> api_usage + query_interpretation (HAM cikti) -> dogrulama -> plan
 *
 * Bayrak: `QUERY_INTENT_V2=off|shadow|on`, YALNIZCA `GEMINI_REALTIME_ENABLED=true`
 * ve anahtar varken etkin (CLAUDE.md kural 1, 0062). Etkinken v1 anlik yorum
 * cagrisi yapilmaz (sorgu basina tek cagri; `stored-plan.ts`).
 * - `shadow`: yorum alinir ve saklanir, arama DEGISMEZ.
 * - `on`: yalnizca H kipi (dogrulanmis bütçe, acik marka, haric marka, uretimde
 *   dogrulanmis kategori) mevcut sorgunun BOS filtre alanlarina eklenir
 *   (`applyIntentPlan`). R ipuclari bu surumde siralamaya baglanmaz.
 *
 * Saklanan HAM cikti her okumada guncel dogrulayici + guncel sozlukle yeniden
 * dogrulanir (0171 §6.4). Model urun, fiyat, magaza, SQL uretmez.
 * Asla firlatmaz: her hata `applied: false` ile deterministik aramaya duser.
 * Log yalnizca sabit kodlar tasir; sorgu metni, istem ya da ham yanit yok.
 */
import { createHash } from "node:crypto";
import { apiUsage, type Database, queryInterpretation } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import { SecretNotConfiguredError } from "../auth/token.ts";
import { recordModelFailure } from "../eval/model-errors.ts";
import {
  buildIntentV2Input,
  buildIntentV2JsonSchema,
  INTENT_SCHEMA_VERSION,
  INTENT_V2_INSTRUCTIONS,
  intentV2ContractHash,
} from "../intent/contract.ts";
import { analyzeLocally } from "../intent/local-analysis.ts";
import { fromRawQuery } from "../intent/normalized-query-adapter.ts";
import { decideRoute, type RouteReason } from "../intent/route.ts";
import { applyIntentPlan, type IntentSearchPlan, toSearchPlan } from "../intent/to-search.ts";
import { validateIntentV2 } from "../intent/validate.ts";
import type { LlmCall, LlmClient } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import { getLlmClient } from "../llm/gemini.ts";
import { llmCallCostMicros } from "../llm/pricing.ts";
import {
  type ProviderBudgetHooks,
  type ProviderBudgetReservation,
  reserveProviderBudget,
  settleProviderBudget,
} from "../quota/provider-budget.ts";
import { consumeQuota, type QuotaConsumer } from "../quota/redis-windows.ts";
import { getRedis, isRedisUnavailableError } from "../redis/client.ts";
import { queryContentIneligibility } from "./interpretation-eligibility.ts";
import type { LexiconEntry } from "./lexicon.ts";
import { loadLexiconCached } from "./lexicon-cache.ts";
import { normalizeQueryText } from "./normalize.ts";
import {
  isRealtimeInterpretationEnabled,
  REALTIME_INTERPRETATION_CLIENT_OPTIONS,
  REALTIME_INTERPRETATION_DAILY_CALL_CAP,
  REALTIME_INTERPRETATION_OPERATION,
  type RealtimeActor,
  realtimeActorQuota,
  type SingleFlight,
} from "./realtime-interpretation.ts";
import type { QueryObject } from "./types.ts";

export type IntentV2Mode = "off" | "shadow" | "on";

type Env = Readonly<Record<string, string | undefined>>;

/** Bayrak + 0062 on kosulu. Taninmayan deger `off` (guvenli taraf). */
export function intentV2Mode(env: Env = process.env): IntentV2Mode {
  if (!isRealtimeInterpretationEnabled(env)) return "off";
  const value = env.QUERY_INTENT_V2?.trim().toLowerCase();
  return value === "on" || value === "shadow" ? value : "off";
}

export const INTENT_V2_MAX_OUTPUT_TOKENS = 512;

export type IntentV2Skip =
  | "disabled"
  | "empty_query"
  | "ineligible"
  | "route_local"
  | "already_interpreted"
  | "in_flight"
  | "daily_cap"
  | "budget_unavailable"
  | "actor_limited"
  | "provider_error"
  | "invalid"
  | "error";

export type IntentV2Resolution =
  | { source: "stored" | "realtime"; plan: IntentSearchPlan; reasons: RouteReason[] }
  | { source: "none"; skip: IntentV2Skip; reasons: RouteReason[] };

export interface IntentV2Options {
  env?: Env;
  client?: LlmClient | null;
  actor?: RealtimeActor;
  now?: () => Date;
  dailyCallCap?: number;
  consume?: QuotaConsumer;
  budget?: ProviderBudgetHooks;
  singleFlight?: SingleFlight;
  /** Testler icin; varsayilan surec ici sozluk onbellegi. */
  lexicon?: readonly LexiconEntry[];
}

const SINGLE_FLIGHT_TTL_MS = 10_000;

const redisSingleFlight: SingleFlight = {
  async acquire(key, ttlMs) {
    return (await getRedis().set(`rtsf:${key}`, "1", "PX", ttlMs, "NX")) === "OK";
  },
  async release(key) {
    await getRedis().del(`rtsf:${key}`);
  },
};

function logCode(stage: string, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.warn(
    `[intent-v2] ${stage} failed`,
    error instanceof Error ? error.name : "unknown",
    typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "",
  );
}

function isRawIntent(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schema_version === INTENT_SCHEMA_VERSION
  );
}

async function readStored(
  db: Database,
  queryNorm: string,
  modelVersion: string,
): Promise<{ status: string; interpretation: unknown } | null> {
  const rows = await db
    .select({
      status: queryInterpretation.status,
      interpretation: queryInterpretation.interpretation,
    })
    .from(queryInterpretation)
    .where(
      and(
        eq(queryInterpretation.queryNorm, queryNorm),
        eq(queryInterpretation.taxonomyHash, intentV2ContractHash()),
        eq(queryInterpretation.modelVersion, modelVersion),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Kural 9 + 0171 §6.4: her deneme `api_usage`'a; HAM cikti `query_interpretation`'a. */
async function persist(
  db: Database,
  input: {
    queryNorm: string;
    modelVersion: string;
    calls: LlmCall[];
    raw: unknown;
    failure: Error | null;
  },
): Promise<void> {
  let lastUsageId: number | null = null;
  await db.transaction(async (tx) => {
    if (input.calls.length > 0) {
      const rows = await tx
        .insert(apiUsage)
        .values(
          input.calls.map((call) => ({
            sessionId: null,
            userId: null,
            operation: REALTIME_INTERPRETATION_OPERATION,
            modelVersion: call.modelVersion,
            units: call.usage?.totalTokens ?? 0,
            costMicros: llmCallCostMicros(call),
            cacheHit: false,
          })),
        )
        .returning({ id: apiUsage.id });
      lastUsageId = rows.at(-1)?.id ?? null;
    }
    // Saglayici hatasinda satir yazilmaz: bir sonraki istek yeniden dener.
    if (input.failure instanceof LlmError) return;
    const valid = isRawIntent(input.raw);
    await tx
      .insert(queryInterpretation)
      .values({
        queryNorm: input.queryNorm,
        taxonomyHash: intentV2ContractHash(),
        modelVersion: input.modelVersion,
        status: valid ? "accepted" : "invalid",
        interpretation: valid ? (input.raw as Record<string, unknown>) : null,
        rejected: valid ? [] : [{ path: "$", reason: "schema_version" }],
      })
      .onConflictDoNothing();
  });
  await recordModelFailure(db, {
    failure: input.failure,
    operation: REALTIME_INTERPRETATION_OPERATION,
    surface: "search",
    modelVersion: input.modelVersion,
    apiUsageId: lastUsageId,
  });
}

function planFrom(
  raw: unknown,
  query: string,
  lexicon: readonly LexiconEntry[],
): IntentSearchPlan | null {
  if (!isRawIntent(raw)) return null;
  const validated = validateIntentV2(raw, { query: fromRawQuery(query), lexicon });
  return toSearchPlan(validated);
}

export async function resolveIntentV2(
  db: Database,
  query: string,
  options: IntentV2Options = {},
): Promise<IntentV2Resolution> {
  const env = options.env ?? process.env;
  if (options.client === undefined && intentV2Mode(env) === "off") {
    return { source: "none", skip: "disabled", reasons: [] };
  }
  const queryNorm = normalizeQueryText(query ?? "");
  if (!queryNorm) return { source: "none", skip: "empty_query", reasons: [] };
  if (queryContentIneligibility(queryNorm) !== null) {
    return { source: "none", skip: "ineligible", reasons: ["ineligible"] };
  }

  let client: LlmClient | null;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    try {
      client = getLlmClient(env, REALTIME_INTERPRETATION_CLIENT_OPTIONS);
    } catch (error) {
      if (!(error instanceof LlmError)) logCode("client", error);
      return { source: "none", skip: "disabled", reasons: [] };
    }
  }
  if (client === null) return { source: "none", skip: "disabled", reasons: [] };

  const flight = options.singleFlight ?? redisSingleFlight;
  const flightKey = createHash("sha256")
    .update(`v2\n${queryNorm}\n${intentV2ContractHash()}\n${client.modelVersion}`)
    .digest("hex")
    .slice(0, 40);
  let flightHeld = false;

  try {
    const lexicon = options.lexicon ?? (await loadLexiconCached(db));
    const stored = await readStored(db, queryNorm, client.modelVersion);
    if (stored !== null) {
      const plan =
        stored.status === "accepted" ? planFrom(stored.interpretation, query, lexicon) : null;
      return plan
        ? { source: "stored", plan, reasons: ["cache_hit"] }
        : { source: "none", skip: "already_interpreted", reasons: ["cache_hit"] };
    }

    const route = decideRoute(analyzeLocally(fromRawQuery(query), lexicon), {
      eligible: true,
      cacheHit: false,
    });
    if (!route.callModel) return { source: "none", skip: "route_local", reasons: route.reasons };

    try {
      flightHeld = await flight.acquire(flightKey, SINGLE_FLIGHT_TTL_MS);
      if (!flightHeld) return { source: "none", skip: "in_flight", reasons: route.reasons };
    } catch (error) {
      logCode("single flight", error);
    }

    const now = options.now ?? (() => new Date());
    const cap = Math.min(
      Math.max(0, options.dailyCallCap ?? REALTIME_INTERPRETATION_DAILY_CALL_CAP),
      REALTIME_INTERPRETATION_DAILY_CALL_CAP,
    );
    let reservation: ProviderBudgetReservation;
    try {
      const budget = await (options.budget?.reserve ?? reserveProviderBudget)({
        operation: REALTIME_INTERPRETATION_OPERATION,
        amount: REALTIME_INTERPRETATION_CLIENT_OPTIONS.maxAttempts,
        cap,
        now: now(),
      });
      if (!budget.allowed) return { source: "none", skip: "daily_cap", reasons: route.reasons };
      reservation = budget.reservation;
    } catch (error) {
      if (!isRedisUnavailableError(error)) throw error;
      logCode("provider budget", error);
      return { source: "none", skip: "budget_unavailable", reasons: route.reasons };
    }

    const calls: LlmCall[] = [];
    let raw: unknown = null;
    let failure: Error | null = null;
    let attempts: number | null = 0;
    try {
      if (options.actor) {
        try {
          const quota = await (options.consume ?? consumeQuota)({
            ...realtimeActorQuota(options.actor),
            now: now(),
          });
          if (!quota.allowed)
            return { source: "none", skip: "actor_limited", reasons: route.reasons };
        } catch (error) {
          if (!isRedisUnavailableError(error) && !(error instanceof SecretNotConfiguredError)) {
            throw error;
          }
          logCode("actor limit", error);
          return { source: "none", skip: "actor_limited", reasons: route.reasons };
        }
      }
      attempts = null;
      try {
        const result = await client.generateJson(
          {
            systemInstruction: INTENT_V2_INSTRUCTIONS,
            input: buildIntentV2Input(query),
            schema: buildIntentV2JsonSchema(),
            maxOutputTokens: INTENT_V2_MAX_OUTPUT_TOKENS,
          },
          { onCall: (call) => calls.push(call) },
        );
        raw = result.value;
      } catch (error) {
        failure = error instanceof Error ? error : new Error("unknown");
      }
      attempts = calls.length;
    } finally {
      if (attempts !== null) {
        await (options.budget?.settle ?? settleProviderBudget)(reservation, attempts).catch(
          (error: unknown) => logCode("provider budget settle", error),
        );
      }
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await persist(db, { queryNorm, modelVersion: client.modelVersion, calls, raw, failure });
        break;
      } catch (error) {
        if (attempt === 2) logCode("persist", error);
      }
    }

    if (failure) {
      console.warn(
        "[intent-v2] provider error",
        failure instanceof LlmError ? failure.code : "unexpected",
      );
      return { source: "none", skip: "provider_error", reasons: route.reasons };
    }
    const plan = planFrom(raw, query, lexicon);
    return plan
      ? { source: "realtime", plan, reasons: route.reasons }
      : { source: "none", skip: "invalid", reasons: route.reasons };
  } catch (error) {
    logCode("lookup", error);
    return { source: "none", skip: "error", reasons: [] };
  } finally {
    if (flightHeld) await flight.release(flightKey).catch(() => undefined);
  }
}

export interface IntentV2Applied {
  parsed: QueryObject;
  mode: IntentV2Mode;
  /** Arama filtresi gercekten degisti mi (yalniz `on`). */
  applied: boolean;
  source: "stored" | "realtime" | "none";
  hardFilters: number;
}

/** `/ara` icin: mod `on` ise H filtrelerini bos alanlara ekler; aksi halde `parsed` aynen. */
export async function applyIntentV2(
  db: Database,
  query: string,
  parsed: QueryObject,
  options: IntentV2Options = {},
): Promise<IntentV2Applied> {
  const mode = options.client !== undefined ? "on" : intentV2Mode(options.env ?? process.env);
  if (mode === "off") return { parsed, mode, applied: false, source: "none", hardFilters: 0 };
  const resolution = await resolveIntentV2(db, query, options);
  if (resolution.source === "none") {
    return { parsed, mode, applied: false, source: "none", hardFilters: 0 };
  }
  const hardFilters = Object.keys(resolution.plan.filters).length;
  // Rol ipucu da (karar 0197) uygulanir: H filtresi olmasa bile siralamayi etkiler.
  if (mode === "shadow" || (hardFilters === 0 && resolution.plan.hints.role === null)) {
    return { parsed, mode, applied: false, source: resolution.source, hardFilters };
  }
  const merged = applyIntentPlan(parsed, resolution.plan);
  const applied =
    JSON.stringify(merged.filters) !== JSON.stringify(parsed.filters) ||
    merged.product_role !== parsed.product_role;
  return { parsed: merged, mode, applied, source: resolution.source, hardFilters };
}
