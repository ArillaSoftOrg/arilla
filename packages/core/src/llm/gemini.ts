/**
 * Gemini metin istemcisi — resmi Interactions API, dogrudan HTTP
 * (docs/decisions/0059). Jina istemcisiyle ayni desen: SDK yok, `fetch`
 * enjekte edilebilir, testler ag kullanmaz.
 *
 * - Uc nokta: kararli `POST https://generativelanguage.googleapis.com/v1/interactions`
 *   (v1beta degil; Interactions API v1'de genel kullanimda).
 * - Anahtar yalnizca `x-goog-api-key` basliginda gider; govdede ya da adreste yok.
 * - `store: false`: Google varsayilan olarak etkilesimi saklar; saklatmayiz.
 * - Yapilandirilmis cikti: `response_format` (`application/json` + JSON Schema).
 * - `generation_config.thinking_level: "minimal"`: kucuk, kapali uclu bir
 *   siniflandirma; dusunme cikti fiyatiyla ucretlenir. `temperature`
 *   gonderilmez (v1 `generation_config` alanlari arasinda yok).
 * - Yalnizca `status: "completed"` kabul edilir. `max_output_tokens`'a takilan
 *   yanit `incomplete` doner ve reddedilir: kesik cikti asla kabul edilmez.
 *
 * Yeniden deneme yalnizca 429, 5xx, zaman asimi ve ag hatasinda; toplam
 * deneme `MAX_ATTEMPTS` ile sinirli. Diger 4xx hemen biter.
 */
import {
  EMPTY_USAGE,
  type LlmCall,
  type LlmCallOptions,
  type LlmClient,
  LlmError,
  type LlmJsonRequest,
  type LlmJsonResult,
  type LlmUsage,
} from "./client.ts";

/** Incelenen kod sabiti; kullanici ya da ortam degistiremez. */
export const GEMINI_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1/interactions";
/** Yorum kucuk bir siniflandirma; en dusuk belgelenmis dusunme seviyesi. */
export const GEMINI_THINKING_LEVEL = "minimal";

export const GEMINI_TIMEOUT_MS = 15_000;
/** Ilk deneme + en fazla iki yeniden deneme. */
export const GEMINI_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
/** `Retry-After` bundan uzunsa beklenmez; toplu isin sure butcesi korunur. */
const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * v1 Interaction `status` degerleri; yalnizca bunlar hataya yazilir.
 * `completed` disindaki her deger (ozellikle `incomplete`) reddedilir.
 */
const KNOWN_STATUSES = new Set([
  "in_progress",
  "requires_action",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
]);

export interface GeminiClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1); jitter icin. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseUsage(raw: unknown): LlmUsage {
  if (!isRecord(raw)) return { ...EMPTY_USAGE };
  return {
    inputTokens: tokenCount(raw.total_input_tokens),
    outputTokens: tokenCount(raw.total_output_tokens),
    thoughtTokens: tokenCount(raw.total_thought_tokens),
    totalTokens: tokenCount(raw.total_tokens),
  };
}

/** Saniye ya da HTTP tarihi; okunamazsa null. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function errorForStatus(status: number): LlmError {
  if (status === 429) return new LlmError("rate_limited", status);
  if (status >= 500) return new LlmError("server_error", status);
  if (status === 401 || status === 403) return new LlmError("auth", status);
  return new LlmError("client_error", status);
}

/** Yanit govdesini okumadan birakir; icerigi hataya tasimayiz. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Govde zaten tuketilmis ya da kapanmis; onemli degil.
  }
}

/** Basarili etkilesimden model metnini cikarir; bicim bozuksa `malformed_response`. */
function extractText(payload: unknown): string {
  if (!isRecord(payload)) throw new LlmError("malformed_response");
  const status = payload.status;
  if (status !== "completed") {
    const detail = typeof status === "string" && KNOWN_STATUSES.has(status) ? status : null;
    throw new LlmError(detail === null ? "malformed_response" : "incomplete", null, detail);
  }
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const parts: string[] = [];
  for (const step of steps) {
    if (!isRecord(step) || step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const item of step.content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
  }
  const text = parts.join("");
  if (text.trim().length === 0) throw new LlmError("malformed_response");
  return text;
}

export class GeminiClient implements LlmClient {
  readonly modelVersion = GEMINI_MODEL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly apiKey: string,
    options: GeminiClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? GEMINI_MAX_ATTEMPTS);
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async generateJson(
    request: LlmJsonRequest,
    options: LlmCallOptions = {},
  ): Promise<LlmJsonResult> {
    const body = JSON.stringify({
      model: GEMINI_MODEL,
      system_instruction: request.systemInstruction,
      input: request.input,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: request.schema,
      },
      generation_config: {
        max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        thinking_level: GEMINI_THINKING_LEVEL,
      },
      store: false,
    });

    const payload = await this.postWithRetry(body, options.onCall);
    const text = extractText(payload);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new LlmError("invalid_json");
    }
    return {
      value,
      usage: parseUsage(isRecord(payload) ? payload.usage : undefined),
      modelVersion: GEMINI_MODEL,
    };
  }

  /** Her HTTP denemesi icin tam bir kez; gozlemci hatasi istemciyi etkilemez. */
  private report(onCall: LlmCallOptions["onCall"], call: Omit<LlmCall, "modelVersion">): void {
    if (!onCall) return;
    try {
      onCall({ modelVersion: GEMINI_MODEL, ...call });
    } catch {
      // Muhasebe gozlemcisi hata verdi; saglayici sonucu degismez.
    }
  }

  private async postWithRetry(body: string, onCall?: LlmCallOptions["onCall"]): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      let error: LlmError;
      let waitHint: number | null = null;
      try {
        const response = await this.fetchImpl(GEMINI_INTERACTIONS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            this.report(onCall, { httpStatus: response.status, usage: null });
            throw new LlmError("malformed_response", response.status);
          }
          // Kullanim, cikti sonradan reddedilse (incomplete, gecersiz JSON) bile kaydedilir.
          this.report(onCall, {
            httpStatus: response.status,
            usage: isRecord(payload) && "usage" in payload ? parseUsage(payload.usage) : null,
          });
          return payload;
        }
        this.report(onCall, { httpStatus: response.status, usage: null });
        waitHint = retryAfterMs(response.headers.get("retry-after"));
        await discard(response);
        error = errorForStatus(response.status);
      } catch (caught) {
        if (caught instanceof LlmError) throw caught;
        this.report(onCall, { httpStatus: null, usage: null });
        const name = (caught as { name?: unknown } | null)?.name;
        // Ham hata (adres, ic mesaj) tasinmaz; yalnizca sinifi.
        error = new LlmError(
          name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
        );
      }

      if (!error.retryable || attempt >= this.maxAttempts) throw error;
      if (waitHint !== null && waitHint > MAX_RETRY_WAIT_MS) throw error;
      const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      await this.sleep(Math.max(waitHint ?? 0, backoff + Math.floor(this.random() * backoff)));
    }
  }
}

type LlmEnv = Readonly<Record<string, string | undefined>>;

/**
 * Sunucu ortamindan istemci. Anahtar yoksa sahte istemciye DUSULMEZ:
 * `missing_api_key` atilir, cagiran (toplu is) "atlandi" yazar.
 */
export function getLlmClient(
  env: LlmEnv = process.env,
  options: GeminiClientOptions = {},
): LlmClient {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new LlmError("missing_api_key");
  return new GeminiClient(apiKey, options);
}
