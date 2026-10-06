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
 */
export type InterpretationSource = "deterministic" | "stored_model" | "none";

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
