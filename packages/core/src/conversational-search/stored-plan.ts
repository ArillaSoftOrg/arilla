/**
 * `/ara` konusma plani + saklanan model yorumu (docs/decisions/0030, 0059).
 *
 * Sira:
 * 1. Deterministik cikarici ilk turdaki sorguda domain bulursa saklanan yorum
 *    HIC okunmaz; plan bugunku yolla aynidir.
 * 2. Bulamazsa normalize sorgu icin saklanan, kabul edilmis ve bugun gecerli
 *    yorum okunur (`readStoredInterpretation`; model cagrisi yok, yazma yok).
 * 3. Yorum varsa ilk turdan hemen sonra en dusuk oncelikte uygulanir; URL'deki
 *    sonraki adimlar (acik kullanici cevaplari) onun ustune oynatilir. Yoksa
 *    plan bugunku yolla birebir aynidir.
 *
 * Okuma hatasi `null` olur ve aramayi durdurmaz. Planlamanin kendi hatalari
 * burada yutulmaz; cagiran (`/ara`) onlari bugun oldugu gibi ele alir.
 */
import type { Database } from "@arilla/db";
import type { CompileOptions, ExtractContext } from "../clarification/index.ts";
import { normalizeQueryText } from "../search/normalize.ts";
import {
  isRealtimeInterpretationEnabled,
  type RealtimeInterpretationOptions,
  type RealtimeSkipReason,
  resolveRealtimeInterpretation,
} from "../search/realtime-interpretation.ts";
import { detectUnsupportedIntents, type SearchSummaryIntent } from "../search/search-summary.ts";
import { readStoredInterpretation } from "../search/stored-interpretation.ts";
import {
  type ConversationPlan,
  type ConversationRequest,
  firstTurnFindsDomain,
  planConversation,
} from "./plan.ts";

/**
 * Ilk turun yorum kaynagi:
 * - `deterministic`: kural sozlugu domain buldu; saklanan yorum okunmadi.
 * - `stored_model`: domain yok; saklanan, kabul edilmis model yorumu uygulandi
 *   (en dusuk oncelik).
 * - `none`: domain yok ve gecerli saklanan yorum yok; bugunku yol.
 * - `realtime_model`: anlik yorum (karar 0062) bu istekte Gemini'den geldi
 *   ve ilk turda en dusuk oncelikle uygulandi.
 */
export type InterpretationSource = "deterministic" | "stored_model" | "realtime_model" | "none";

/** `/ara` ve yonetim tanisinin ORTAK yolu: plan + yorum kaynagi. Salt okunur. */
export async function planConversationWithInterpretationSource(
  db: Database,
  request: ConversationRequest,
  context: ExtractContext,
  compileOptions: CompileOptions = {},
): Promise<{ plan: ConversationPlan; interpretationSource: InterpretationSource }> {
  if (firstTurnFindsDomain(request.query, context)) {
    return {
      plan: planConversation(request, context, compileOptions),
      interpretationSource: "deterministic",
    };
  }
  const stored = await readStoredInterpretation(db, normalizeQueryText(request.query), {
    registry: context.registry,
  });
  return {
    plan: planConversation(request, context, compileOptions, { firstTurnInterpretation: stored }),
    interpretationSource: stored === null ? "none" : "stored_model",
  };
}

export async function planConversationWithStoredInterpretation(
  db: Database,
  request: ConversationRequest,
  context: ExtractContext,
  compileOptions: CompileOptions = {},
): Promise<ConversationPlan> {
  return (await planConversationWithInterpretationSource(db, request, context, compileOptions))
    .plan;
}

/**
 * `/ara` icin anlik yorumlu plan (karar 0062). Yalnizca `/ara` cagirir;
 * yonetim tanisi salt okunur `planConversationWithInterpretationSource`
 * kullanir (tani ekrani Gemini cagirmaz).
 *
 * - Bayrak kapaliysa (`GEMINI_REALTIME_ENABLED`) davranis BUGUNKUYLE AYNI.
 * - Aciksa: deterministik domain bulunsa da yorum alinir (saklanan ya da bu
 *   istekte Gemini) ve `firstTurnEnrichment` ile yalnizca eksikleri doldurur.
 *   Oncelik: acik kullanici beyani > deterministik > Gemini.
 * - Yorum alinamazsa (suzgec, tavan, zaman asimi, hata) plan deterministik
 *   yolla birebir aynidir; kullanici yalnizca normal sonuclari gorur.
 */
export async function planConversationWithRealtimeInterpretation(
  db: Database,
  request: ConversationRequest,
  context: ExtractContext,
  options: { compileOptions?: CompileOptions; realtime?: RealtimeInterpretationOptions } = {},
): Promise<{
  plan: ConversationPlan;
  interpretationSource: InterpretationSource;
  realtimeSkip: RealtimeSkipReason | null;
  /** Yalnizca model yorumu uygulandiysa; `/ara` ozeti bundan kurar. */
  summaryIntent: SearchSummaryIntent | null;
}> {
  const compileOptions = options.compileOptions ?? {};
  const realtime = options.realtime ?? {};
  const enabled =
    realtime.client !== undefined || isRealtimeInterpretationEnabled(realtime.env ?? process.env);
  if (!enabled || !request.query.trim()) {
    const legacy = await planConversationWithInterpretationSource(
      db,
      request,
      context,
      compileOptions,
    );
    return { ...legacy, realtimeSkip: enabled ? "empty_query" : "disabled", summaryIntent: null };
  }

  const result = await resolveRealtimeInterpretation(db, request.query, {
    ...realtime,
    registry: realtime.registry ?? context.registry,
  });
  if (result.source === "none") {
    return {
      plan: planConversation(request, context, compileOptions),
      interpretationSource: firstTurnFindsDomain(request.query, context) ? "deterministic" : "none",
      realtimeSkip: result.reason,
      summaryIntent: null,
    };
  }
  const plan = planConversation(request, context, compileOptions, {
    firstTurnInterpretation: result.interpretation,
    firstTurnEnrichment: true,
  });
  return {
    plan,
    interpretationSource: result.source === "realtime" ? "realtime_model" : "stored_model",
    realtimeSkip: null,
    summaryIntent: summaryIntentOf(plan, context, request.query),
  };
}

/** Ozetin girdisi: yalnizca planin dogruladigi degerler ve sorgudaki desteksiz niyetler. */
function summaryIntentOf(
  plan: ConversationPlan,
  context: ExtractContext,
  query: string,
): SearchSummaryIntent | null {
  if (plan.mode !== "conversation") return null;
  const domain = context.registry.domains.find((d) => d.id === plan.domainId);
  const { price_min: minKurus = null, price_max: maxKurus = null } = plan.queryObject.filters;
  return {
    typeLabel: domain?.label ?? null,
    budget: minKurus !== null || maxKurus !== null ? { minKurus, maxKurus } : null,
    constraintLabels: plan.constraints.filter((chip) => chip.key !== "budget").map((c) => c.label),
    unsupported: detectUnsupportedIntents(query),
  };
}
