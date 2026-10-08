/**
 * Saglayicidan bagimsiz metin modeli sozlesmesi (docs/decisions/0059).
 *
 * YALNIZCA sunucu ve toplu is icindir: CLAUDE.md kural 1 geregi kullanici
 * istegi sirasinda cagrilmaz. Anahtar yalnizca `getLlmClient` icinde sunucu
 * ortamindan okunur; bu modul hicbir `NEXT_PUBLIC_` degiskeni okumaz ve
 * istemci bilesenlerinin kullandigi alt yollardan disa acilmaz.
 *
 * Hata mesajlari yalnizca sabit kod ve HTTP durumunu tasir: anahtar, istem,
 * sorgu metni ya da yanit govdesi ASLA mesaja, alana veya `cause`'a girmez.
 */

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Dusunme token'lari; cikti fiyatiyla ucretlenir. */
  thoughtTokens: number;
  totalTokens: number;
}

/** Tek bir satir ici gorsel (karar 0078); yalnizca sunucuda, bellekte. */
export interface LlmInlineImage {
  mimeType: "image/jpeg" | "image/png";
  /** Standart base64 (satir sonu yok). */
  dataBase64: string;
}

export interface LlmJsonRequest {
  systemInstruction: string;
  input: string;
  /** Verilirse istek cok kiplidir: metin + gorseller (Interactions API `input` dizisi). */
  images?: readonly LlmInlineImage[];
  /** Saglayicinin desteklemesi gereken JSON Schema alt kumesi. */
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface LlmJsonResult {
  /** Ayristirilmis JSON; dogrulanmamistir, cagiran dogrular. */
  value: unknown;
  usage: LlmUsage;
  modelVersion: string;
}

/**
 * Saglayiciya giden TEK bir HTTP denemesinin muhasebe kaydi. Yeniden
 * denemeler dahil her deneme icin bir kez uretilir; `api_usage` satiri
 * bundan yazilir. Icerik tasimaz: yalnizca durum ve token sayilari.
 */
export interface LlmCall {
  modelVersion: string;
  /** Yanit gelmediyse (zaman asimi, ag) `null`. */
  httpStatus: number | null;
  /** Yanitta okunabilen kullanim; yoksa `null`. Gecersiz ciktida da doludur. */
  usage: LlmUsage | null;
}

export interface LlmCallOptions {
  /** Her HTTP denemesinden sonra cagrilir; firlatirsa yutulur. */
  onCall?: (call: LlmCall) => void;
}

export interface LlmClient {
  readonly modelVersion: string;
  generateJson(request: LlmJsonRequest, options?: LlmCallOptions): Promise<LlmJsonResult>;
}

export type LlmErrorCode =
  | "missing_api_key"
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "auth"
  | "client_error"
  | "incomplete"
  | "malformed_response"
  | "invalid_json";

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set([
  "timeout",
  "network",
  "rate_limited",
  "server_error",
]);

export class LlmError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: LlmErrorCode,
    readonly httpStatus: number | null = null,
    /** Saglayicinin sabit durum degeri (or. `incomplete`); serbest metin degil. */
    readonly detail: string | null = null,
  ) {
    super(
      `llm: ${code}${httpStatus === null ? "" : ` (HTTP ${httpStatus})`}${
        detail === null ? "" : ` [${detail}]`
      }`,
    );
    this.name = "LlmError";
    this.retryable = RETRYABLE.has(code);
  }
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
};
