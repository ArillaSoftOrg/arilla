/**
 * Gemini baglanti dumani - YALNIZCA sabit sentetik sorgu (docs/decisions/0059).
 *
 * Uretim istemcisini (`getLlmClient` -> `GeminiClient`) ve yorumlayici
 * dogrulamasini aynen kullanir; boylece model, kimlik dogrulama, `store:
 * false`, zaman asimi ve yanit ayristirma gercek API'ye karsi sinanir.
 *
 * Guvenlik ozellikleri (testlerle sabit):
 * - Gonderilen metin her zaman `SMOKE_QUERY`dir; disaridan metin ALINMAZ
 *   (komut satiri argumani verilirse reddedilir).
 * - Veritabani modulu yuklenmez: `search_query_day`, kullanici sorgusu ya da
 *   gecmis OKUNMAZ; `api_usage`/`job_run`'a yazma YOK.
 * - Acik onay sart: `GEMINI_SMOKE=1`. Uretim ortami isaretliyse
 *   (`VERCEL_ENV=production` ya da `NODE_ENV=production`) ayrica
 *   `GEMINI_SMOKE_ALLOW_PRODUCTION=1`.
 * - Tam olarak bir HTTP denemesi (`maxAttempts: 1`).
 * - Rapor yalnizca durum kodlari ve sayilardir: anahtar, istem, ham yanit ya
 *   da yorum icerigi yok.
 */
import { describeTaxonomy } from "../clarification/interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { createInitialState } from "../clarification/state.ts";
import { type GeminiClientOptions, getLlmClient } from "./gemini.ts";
import { interpretWithModel, LlmIntentInterpreter } from "./intent-interpreter.ts";

/** Sabit, sentetik, kisisel veri icermeyen sorgu. Degistirmek kod incelemesidir. */
export const SMOKE_QUERY = "motor sürerken kafa koruyucu";

export const SMOKE_CLIENT_OPTIONS = { maxAttempts: 1, timeoutMs: 20_000 } as const;

export type SmokeRefusal =
  | "missing_opt_in"
  | "production_not_allowed"
  | "unexpected_arguments"
  | "missing_api_key";

export type SmokeReport =
  | { result: "refused"; reason: SmokeRefusal }
  | {
      result: "pass" | "fail";
      httpAttempts: number;
      httpStatus: number | null;
      api: "success" | "failure";
      providerCode: string | null;
      model: string;
      validation: "accepted" | "empty" | "invalid" | "provider_error";
      rejectedCodes: string[];
      inputTokens: number | null;
      outputTokens: number | null;
      thoughtTokens: number | null;
      totalTokens: number | null;
    };

type Env = Readonly<Record<string, string | undefined>>;

export async function runGeminiSmoke(
  env: Env,
  options: { args?: readonly string[]; fetch?: GeminiClientOptions["fetch"] } = {},
): Promise<SmokeReport> {
  if (env.GEMINI_SMOKE !== "1") return { result: "refused", reason: "missing_opt_in" };
  const production = env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
  if (production && env.GEMINI_SMOKE_ALLOW_PRODUCTION !== "1") {
    return { result: "refused", reason: "production_not_allowed" };
  }
  if ((options.args ?? []).length > 0) {
    return { result: "refused", reason: "unexpected_arguments" };
  }
  if (!env.GEMINI_API_KEY?.trim()) return { result: "refused", reason: "missing_api_key" };

  const registry = DEFAULT_CLARIFICATION_REGISTRY;
  const client = getLlmClient(env, {
    ...SMOKE_CLIENT_OPTIONS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const outcome = await interpretWithModel(
    new LlmIntentInterpreter(client, registry),
    { text: SMOKE_QUERY, state: createInitialState(), taxonomy: describeTaxonomy(registry) },
    registry,
  );

  const call = outcome.calls[0];
  const usage = call?.usage ?? null;
  return {
    result: outcome.status === "accepted" || outcome.status === "empty" ? "pass" : "fail",
    httpAttempts: outcome.calls.length,
    httpStatus: call?.httpStatus ?? null,
    api: outcome.status === "provider_error" ? "failure" : "success",
    providerCode: outcome.status === "provider_error" ? outcome.code : null,
    model: outcome.modelVersion,
    validation: outcome.status,
    rejectedCodes:
      outcome.status === "accepted" || outcome.status === "invalid"
        ? outcome.rejected.map((r) => r.reason)
        : [],
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    thoughtTokens: usage?.thoughtTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };
}

/** Yalnizca guvenli alanlar; her satir `ad: deger`. */
export function formatSmokeReport(report: SmokeReport): string[] {
  if (report.result === "refused") {
    return [`result: refused (${report.reason}; no request was sent)`];
  }
  return [
    `http_attempts: ${report.httpAttempts}`,
    `http_status: ${report.httpStatus ?? "none"}`,
    `api: ${report.api}${report.providerCode ? ` (${report.providerCode})` : ""}`,
    `model: ${report.model}`,
    `validation: ${report.validation}`,
    `rejected_codes: ${report.rejectedCodes.join(",") || "none"}`,
    `input_tokens: ${report.inputTokens ?? "n/a"}`,
    `output_tokens: ${report.outputTokens ?? "n/a"}`,
    `thought_tokens: ${report.thoughtTokens ?? "n/a"}`,
    `total_tokens: ${report.totalTokens ?? "n/a"}`,
    `result: ${report.result.toUpperCase()}`,
  ];
}
