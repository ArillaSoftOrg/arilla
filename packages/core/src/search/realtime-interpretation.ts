/**
 * Anlik Gemini sorgu yorumu (docs/decisions/0062). `/ara` isteginin ICINDE:
 *
 *   normalize -> metin suzgeci -> saklanan yorum (varsa yeniden kullan)
 *   -> gunluk tavan -> Gemini (kisa zaman asimi, tek deneme) -> dogrulama
 *   -> api_usage + query_interpretation (toplu isle ayni yazma yolu)
 *
 * Donen yorum aramayi DOGRUDAN degistirir: `planConversation` onu ilk turda
 * en dusuk oncelikle uygular, `compileQuery` domain'i kategori suzgecine,
 * butceyi `price_min`/`price_max`'a, nitelikleri metin niteleyicilerine
 * cevirir. Urun, fiyat, magaza ya da stok modelden GELMEZ: model yalnizca
 * sabit taksonomiden kimlik secer, arama veritabaninda kosar.
 *
 * Asla firlatmaz: kapali bayrak, suzgec, tavan, zaman asimi, saglayici hatasi,
 * gecersiz cikti ya da veritabani hatasi `source: "none"` doner ve arama
 * bugunku deterministik yoldan devam eder. Log yalnizca sabit kod tasir;
 * sorgu metni, istem ya da ham yanit loglanmaz.
 */
import { createHash } from "node:crypto";
import { type Database, queryInterpretation } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { describeTaxonomy, type ValidatedInterpretation } from "../clarification/interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { createInitialState } from "../clarification/state.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import type { LlmClient } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import { getLlmClient } from "../llm/gemini.ts";
import { interpretWithModel, LlmIntentInterpreter } from "../llm/intent-interpreter.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";
import { type IneligibleReason, queryContentIneligibility } from "./interpretation-eligibility.ts";
import { currentInterpretationIdentity } from "./interpretation-identity.ts";
import { normalizeQueryText } from "./normalize.ts";
import { persistOutcome, providerCallsToday } from "./query-interpretation.ts";
import { parseStoredInterpretation } from "./stored-interpretation.ts";

/** `api_usage.operation`: toplu isin tavanindan (`query_interpretation`) ayri sayilir. */
export const REALTIME_INTERPRETATION_OPERATION = "query_interpretation_realtime";

/**
 * Europe/Istanbul gunu basina anlik saglayici HTTP denemesi. Asilinca arama
 * deterministik yoldan devam eder (kullanici fark etmez). Toplu isin 100'luk
 * tavani etkilenmez. Yukseltmek kod incelemesidir.
 */
export const REALTIME_INTERPRETATION_DAILY_CALL_CAP = 2000;

/**
 * Etkilesimli arama butcesi: tek deneme, 2,5 sn. Flash-Lite + `minimal`
 * dusunme + ~1k token istem tipik olarak 0,6-1,5 sn surer; 2,5 sn en kotu
 * durumda sayfaya eklenen beklemeyi sinirlar. Yeniden deneme yok: ikinci
 * deneme kullaniciyi bekletir, hata zaten deterministik aramaya duser.
 */
export const REALTIME_INTERPRETATION_CLIENT_OPTIONS = { timeoutMs: 2_500, maxAttempts: 1 } as const;

/**
 * Kisi basina anlik saglayici cagrisi: saatte 30. Tek bir anonim aktor (ya da
 * bot) 2.000'lik gunluk butcenin tamamini tuketemesin. Yalnizca GERCEK model
 * cagrisi sayilir (onbellek isabeti ve suzgece takilan sorgu sayilmaz).
 * Anahtar girisli hesap ya da IP'nin SHA-256 ozeti; IP cozulemezse ortak kova.
 * Redis erisilemezse model cagrilmaz (maliyet kapali), arama surer.
 */
export const REALTIME_INTERPRETATION_ACTOR_LIMIT = 30;
export const REALTIME_INTERPRETATION_ACTOR_WINDOW_SECONDS = 60 * 60;

export interface RealtimeActor {
  userId: number | null;
  ip: string | null;
}

export function realtimeActorKey(actor: RealtimeActor): string {
  if (actor.userId !== null) return `rti:user:${actor.userId}`;
  if (actor.ip) return `rti:ip:${createHash("sha256").update(actor.ip.trim()).digest("hex")}`;
  return "rti:ip:unknown";
}

type Env = Readonly<Record<string, string | undefined>>;

/** Acik bayrak (`GEMINI_REALTIME_ENABLED=true`) VE anahtar. Varsayilan kapali. */
export function isRealtimeInterpretationEnabled(env: Env = process.env): boolean {
  return (
    env.GEMINI_REALTIME_ENABLED?.trim().toLowerCase() === "true" &&
    Boolean(env.GEMINI_API_KEY?.trim())
  );
}

export type RealtimeSkipReason =
  | "disabled"
  | "empty_query"
  | IneligibleReason
  /** Bu kimlik icin daha once yorum yapildi ama kullanilabilir sonuc yok (bos/gecersiz). */
  | "already_interpreted"
  | "daily_cap"
  /** Kisi basina anlik limit doldu ya da limit sayaci okunamadi. */
  | "actor_limited"
  | "provider_error"
  | "invalid"
  | "empty"
  | "error";

export type RealtimeInterpretationResult =
  | { source: "stored"; interpretation: ValidatedInterpretation }
  | { source: "realtime"; interpretation: ValidatedInterpretation }
  | { source: "none"; reason: RealtimeSkipReason };

export interface RealtimeInterpretationOptions {
  registry?: ClarificationRegistry;
  env?: Env;
  /** Testler icin; verilmezse ortamdan kisa zaman asimli Gemini istemcisi. */
  client?: LlmClient | null;
  now?: () => Date;
  /** Testler icin; varsayilan `REALTIME_INTERPRETATION_DAILY_CALL_CAP`, yukseltilemez. */
  dailyCallCap?: number;
  /**
   * Kisi basina limit. Verilmezse (ör. testler, yonetim) limit uygulanmaz;
   * `/ara` her zaman verir.
   */
  actor?: RealtimeActor;
  /** Testler icin; varsayilan Redis sabit pencere sayaci. */
  increment?: FixedWindowCounter;
}

function safeCode(error: unknown): string {
  const code =
    (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code ??
    (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "";
}

function logFailure(stage: string, error: unknown): void {
  console.warn(
    `[realtime-interpretation] ${stage} failed`,
    error instanceof Error ? error.name : "unknown",
    safeCode(error),
  );
}

/** Kimlik icin herhangi bir durumdaki satir; yoksa `null`. */
async function readStoredRow(
  db: Database,
  queryNorm: string,
  registry: ClarificationRegistry,
  modelVersion: string,
): Promise<{ status: string; interpretation: unknown } | null> {
  const identity = { ...currentInterpretationIdentity(registry), modelVersion };
  const rows = await db
    .select({
      status: queryInterpretation.status,
      interpretation: queryInterpretation.interpretation,
    })
    .from(queryInterpretation)
    .where(
      and(
        eq(queryInterpretation.queryNorm, queryNorm),
        eq(queryInterpretation.taxonomyHash, identity.taxonomyHash),
        eq(queryInterpretation.modelVersion, identity.modelVersion),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveRealtimeInterpretation(
  db: Database,
  queryText: string,
  options: RealtimeInterpretationOptions = {},
): Promise<RealtimeInterpretationResult> {
  const env = options.env ?? process.env;
  if (options.client === undefined && !isRealtimeInterpretationEnabled(env)) {
    return { source: "none", reason: "disabled" };
  }
  const registry = options.registry ?? DEFAULT_CLARIFICATION_REGISTRY;
  const queryNorm = normalizeQueryText(queryText ?? "");
  if (!queryNorm) return { source: "none", reason: "empty_query" };

  // Gemini'ye gitmeden ONCE: kisisel veri, sir, ozel nitelikli veri, uzunluk.
  const ineligible = queryContentIneligibility(queryNorm);
  if (ineligible !== null) return { source: "none", reason: ineligible };

  // Istemci aga cikmadan kurulur; saklanan satirin kimligi onun model surumuyle eslesir.
  let client: LlmClient | null;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    try {
      client = getLlmClient(env, REALTIME_INTERPRETATION_CLIENT_OPTIONS);
    } catch (error) {
      if (error instanceof LlmError) return { source: "none", reason: "disabled" };
      logFailure("client", error);
      return { source: "none", reason: "error" };
    }
  }
  if (client === null) return { source: "none", reason: "disabled" };

  try {
    // Ayni kimlik (sorgu + taksonomi + model surumu) daha once yorumlandiysa
    // yeniden kullanilir; bos/gecersiz sonuc icin model TEKRAR cagrilmaz.
    const row = await readStoredRow(db, queryNorm, registry, client.modelVersion);
    if (row !== null) {
      if (row.status !== "accepted") return { source: "none", reason: "already_interpreted" };
      const stored = parseStoredInterpretation(row.interpretation, queryNorm, registry);
      return stored === null
        ? { source: "none", reason: "already_interpreted" }
        : { source: "stored", interpretation: stored };
    }

    const now = options.now ?? (() => new Date());
    const cap = Math.min(
      Math.max(0, options.dailyCallCap ?? REALTIME_INTERPRETATION_DAILY_CALL_CAP),
      REALTIME_INTERPRETATION_DAILY_CALL_CAP,
    );
    const callsToday = await providerCallsToday(db, now(), REALTIME_INTERPRETATION_OPERATION);
    if (callsToday + REALTIME_INTERPRETATION_CLIENT_OPTIONS.maxAttempts > cap) {
      return { source: "none", reason: "daily_cap" };
    }

    if (options.actor) {
      try {
        const count = await (options.increment ?? incrementFixedWindow)(
          realtimeActorKey(options.actor),
          REALTIME_INTERPRETATION_ACTOR_WINDOW_SECONDS,
        );
        if (count > REALTIME_INTERPRETATION_ACTOR_LIMIT) {
          return { source: "none", reason: "actor_limited" };
        }
      } catch (error) {
        if (!isRedisUnavailableError(error)) throw error;
        logFailure("actor limit", error);
        return { source: "none", reason: "actor_limited" };
      }
    }

    // Toplu isle AYNI istem ve dogrulama: yalnizca sorgu, bos baslangic durumu
    // ve taksonomi gider. Boylece saklanan satir iki yolda da ayni anlamdadir.
    const outcome = await interpretWithModel(
      new LlmIntentInterpreter(client, registry),
      { text: queryNorm, state: createInitialState(), taxonomy: describeTaxonomy(registry) },
      registry,
    );

    try {
      await persistOutcome(db, {
        queryNorm,
        taxonomyHash: currentInterpretationIdentity(registry).taxonomyHash,
        outcome,
        operation: REALTIME_INTERPRETATION_OPERATION,
      });
    } catch (error) {
      // Muhasebe/yazma hatasi kullaniciyi etkilemez; dogrulanmis yorum yine kullanilir.
      logFailure("persist", error);
    }

    if (outcome.status === "accepted") {
      return { source: "realtime", interpretation: outcome.value };
    }
    if (outcome.status === "provider_error") {
      console.warn("[realtime-interpretation] provider error", outcome.code);
      return { source: "none", reason: "provider_error" };
    }
    return { source: "none", reason: outcome.status };
  } catch (error) {
    logFailure("lookup", error);
    return { source: "none", reason: "error" };
  }
}
