/**
 * Gemini cagri sonuclarindan `ai_error_event` kaydi (karar 0099).
 *
 * - Sonuc (outcome) TEK hata olayi uretir; HTTP denemesi basina degil. Yeniden
 *   denemeler `api_usage`ta ayri satirdir, hata olayi ise cagrinin sonucudur.
 * - Icerik yok: yalnizca sabit kod, durum degeri ve HTTP durumu.
 * - Kayit sinirli sureli ve asla firlatmaz; kullanici islemini bozmaz/geciktirmez.
 * - Yeni model cagrisi yapmaz.
 */
import type { AiSurface, Database } from "@arilla/db";
import type { ModelTurnRejection } from "../chat/contract.ts";
import type { InterpretationOutcome } from "../chat/interpreter.ts";
import { type LlmCall, LlmError, type LlmErrorCode } from "../llm/client.ts";
import type { ModelInterpretationOutcome } from "../llm/intent-interpreter.ts";
import { recordAiError } from "./store.ts";

/** Hata kaydi kullanici yolunu bu kadardan fazla bekletmez. */
export const AI_ERROR_RECORD_TIMEOUT_MS = 1500;

const VALIDATION_DETAIL = "validation_rejected";

/** Modelin yanit verdigi ama kullanilamayan cikti sebepleri (sohbet dogrulayicisi). */
const CHAT_VALIDATION_REASONS: ReadonlySet<ModelTurnRejection | string> = new Set([
  "not_object",
  "bad_action",
  "bad_message",
  "bad_question",
  "bad_intent",
]);

/** `unknown` kod siniflanamayan hatadir; LlmError kodu uydurulmaz. */
function providerFailure(
  code: LlmErrorCode | "unknown",
  status: number | null,
  detail: string | null,
) {
  return code === "unknown" ? new Error("unknown model error") : new LlmError(code, status, detail);
}

function lastHttpStatus(calls: readonly LlmCall[]): number | null {
  return calls.at(-1)?.httpStatus ?? null;
}

/** Toplu ve anlik sorgu yorumu sonucu -> hata ya da `null` (basarili/bos). */
export function failureFromInterpretation(outcome: ModelInterpretationOutcome): Error | null {
  const status = lastHttpStatus(outcome.calls);
  if (outcome.status === "provider_error") {
    return providerFailure(outcome.code, status, outcome.errorDetail ?? null);
  }
  if (outcome.status !== "invalid") return null;
  const first = outcome.rejected[0];
  // Cikti hatasi (kesik/JSON degil/bicimsiz) ile alan dogrulama reddi ayri.
  if (first?.path === "$") {
    return new LlmError(first.reason as LlmErrorCode, status, outcome.errorDetail ?? null);
  }
  return new LlmError("malformed_response", status, VALIDATION_DETAIL);
}

/** Sohbet turu sonucu -> hata ya da `null`. */
export function failureFromChatTurn(outcome: InterpretationOutcome): Error | null {
  const status = lastHttpStatus(outcome.calls);
  if (outcome.kind === "provider_error") {
    return providerFailure(outcome.code, status, outcome.errorDetail ?? null);
  }
  if (outcome.modelError) {
    return new LlmError(outcome.modelError.code, status, outcome.modelError.detail);
  }
  if (outcome.fallbackReason && CHAT_VALIDATION_REASONS.has(outcome.fallbackReason)) {
    return new LlmError("malformed_response", status, VALIDATION_DETAIL);
  }
  return null;
}

/**
 * Hata olayini sinirli surede yazar; yazilamazsa ya da sure dolarsa `false`.
 * ASLA firlatmaz.
 */
export async function recordModelFailure(
  db: Database,
  input: {
    failure: Error | null;
    operation: string;
    surface: AiSurface;
    modelVersion: string;
    apiUsageId?: number | null;
    timeoutMs?: number;
  },
): Promise<boolean> {
  if (!input.failure) return false;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), input.timeoutMs ?? AI_ERROR_RECORD_TIMEOUT_MS);
    });
    const write = recordAiError(db, {
      provider: "gemini",
      operation: input.operation,
      surface: input.surface,
      error: input.failure,
      modelVersion: input.modelVersion,
      apiUsageId: input.apiUsageId ?? undefined,
    }).catch(() => false);
    const done = await Promise.race([write, timeout]);
    if (timer) clearTimeout(timer);
    return done;
  } catch {
    return false;
  }
}
