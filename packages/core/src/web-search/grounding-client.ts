/**
 * Gemini Google Search grounding + URL Context istemcisi (docs/decisions/0102).
 *
 * Interactions API, dogrudan HTTP (`llm/gemini.ts` ile ayni desen: SDK yok,
 * `fetch` enjekte edilebilir, testler ag kullanmaz). Farklar:
 * - Uc nokta `v1beta` (grounding araclari yalnizca orada belgeli);
 * - `tools: [google_search, url_context]`;
 * - `response_format` (yapilandirilmis cikti) ARACLARLA BIRLIKTE kullanilmaz:
 *   dokuman birlikte kullanimi onaylamiyor. Model JSON metin uretir, biz
 *   kati sekilde dogrulariz (`parse.ts`);
 * - tek deneme, yeniden deneme yok (kullanici bekler, maliyet katlanmaz);
 * - `store: false`.
 *
 * Hata mesajlari yalnizca sabit kod tasir; sorgu, istem, anahtar ya da yanit
 * govdesi hataya girmez.
 */
import { EMPTY_USAGE, type LlmCall, LlmError, type LlmUsage } from "../llm/client.ts";
import {
  WEB_SEARCH_MAX_OUTPUT_TOKENS,
  WEB_SEARCH_MODEL,
  WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_URL,
} from "./config.ts";
import { toSafePublicUrl } from "./url-safety.ts";

/** Beklenmedik buyuk parca gosterilmez (kotu bicim / kotuye kullanim). */
const MAX_SUGGESTIONS_HTML = 20_000;

export interface GroundingCitation {
  url: string;
  title: string | null;
}

export interface GroundedResponse {
  text: string;
  citations: GroundingCitation[];
  searchQueries: string[];
  /**
   * Google'in `search_suggestions` HTML parcasi (Search Suggestions). Google
   * kosullari gregi grounding sonuclari YALNIZCA bununla birlikte, DEGISTIRILMEDEN
   * gosterilir; yoksa sonuc gosterilmez (`service.ts`).
   */
  searchSuggestionsHtml: string | null;
  /** URL Context ile okunan sayfalar; `ok` = saglayici okumayi basarili bildirdi. */
  retrieved: { url: string; ok: boolean }[];
  usage: LlmUsage;
  modelVersion: string;
  /** Yanit bicimi ozeti (adim turleri + alan adlari; icerik YOK). Yalnizca tanilama gunlugu icin. */
  shape?: string;
}

export interface WebGroundingRequest {
  systemInstruction: string;
  input: string;
}

export interface WebGroundingClient {
  readonly modelVersion: string;
  search(
    request: WebGroundingRequest,
    options?: { onCall?: (call: LlmCall) => void },
  ): Promise<GroundedResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseUsage(raw: unknown): LlmUsage {
  if (!isRecord(raw)) return { ...EMPTY_USAGE };
  const input = tokenCount(raw.total_input_tokens);
  // Arac kullanimi (arama sonuclari, okunan sayfalar) girdi olarak ucretlenir.
  const toolInput = tokenCount(raw.total_tool_use_tokens) || tokenCount(raw.tool_use_input_tokens);
  return {
    inputTokens: input + toolInput,
    outputTokens: tokenCount(raw.total_output_tokens),
    thoughtTokens: tokenCount(raw.total_thought_tokens),
    totalTokens: tokenCount(raw.total_tokens),
  };
}

function errorForStatus(status: number): LlmError {
  if (status === 429) return new LlmError("rate_limited", status);
  if (status >= 500) return new LlmError("server_error", status);
  if (status === 401 || status === 403) return new LlmError("auth", status);
  return new LlmError("client_error", status);
}

/** Sinirli derinlikte gez; sayfa metninden gelen alanlara guvenmeyiz, yalnizca bilinen sekle bakariz. */
function walk(value: unknown, visit: (node: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) walk(item, visit, depth + 1);
  } else if (isRecord(value)) {
    visit(value);
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) walk(child, visit, depth + 1);
    }
  }
}

/** Basarili etkilesim adimlarindan metin, atif, arama sorgulari ve okunan sayfalar. */
export function parseGroundedPayload(
  payload: unknown,
): Omit<GroundedResponse, "usage" | "modelVersion"> {
  if (!isRecord(payload)) throw new LlmError("malformed_response");
  const status = payload.status;
  if (status !== "completed") {
    throw new LlmError(typeof status === "string" ? "incomplete" : "malformed_response");
  }
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const texts: string[] = [];
  const citations: GroundingCitation[] = [];
  const queries: string[] = [];
  const retrieved: { url: string; ok: boolean }[] = [];
  const suggestions: string[] = [];

  for (const step of steps) {
    if (!isRecord(step)) continue;
    if (step.type === "model_output" && Array.isArray(step.content)) {
      for (const item of step.content) {
        if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
        texts.push(item.text);
        if (Array.isArray(item.annotations)) {
          for (const annotation of item.annotations) {
            if (
              isRecord(annotation) &&
              annotation.type === "url_citation" &&
              typeof annotation.url === "string"
            ) {
              citations.push({
                url: annotation.url,
                title: typeof annotation.title === "string" ? annotation.title : null,
              });
            }
          }
        }
      }
    } else if (step.type === "google_search_call") {
      walk(step, (node) => {
        if (Array.isArray(node.queries)) {
          for (const q of node.queries) if (typeof q === "string") queries.push(q);
        }
      });
    } else if (step.type === "google_search_result") {
      walk(step, (node) => {
        if (typeof node.search_suggestions === "string") suggestions.push(node.search_suggestions);
        else if (isRecord(node.search_suggestions)) {
          const html = node.search_suggestions.rendered_content;
          if (typeof html === "string") suggestions.push(html);
        }
      });
    } else if (step.type === "url_context_result") {
      walk(step, (node) => {
        const url =
          typeof node.url === "string"
            ? node.url
            : typeof node.retrieved_url === "string"
              ? node.retrieved_url
              : null;
        const state = node.status ?? node.url_retrieval_status ?? node.retrieval_status;
        if (url !== null && typeof state === "string") {
          retrieved.push({ url, ok: /success/i.test(state) });
        }
      });
    }
  }

  const text = texts.join("");
  if (text.trim().length === 0) throw new LlmError("malformed_response");
  const html = suggestions.join("\n").trim();
  return {
    text,
    citations,
    searchQueries: queries,
    searchSuggestionsHtml: html.length > 0 && html.length <= MAX_SUGGESTIONS_HTML ? html : null,
    retrieved,
  };
}

/** Icerik tasimayan bicim ozeti: adim turu -> alan adlari (en fazla 2 seviye). */
export function describePayloadShape(payload: unknown): string {
  if (!isRecord(payload)) return "non-object";
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const safeKey = (k: string) => (/^[A-Za-z0-9_]{1,40}$/.test(k) ? k : "?");
  const parts = steps.slice(0, 20).map((step) => {
    if (!isRecord(step)) return "?";
    const type = typeof step.type === "string" ? safeKey(step.type) : "?";
    const keys = Object.keys(step).map(safeKey).join("+");
    const inner = Array.isArray(step.result) ? step.result[0] : step.result;
    const innerKeys = isRecord(inner) ? `{${Object.keys(inner).map(safeKey).join("+")}}` : "";
    return `${type}[${keys}]${innerKeys}`;
  });
  return `status=${typeof payload.status === "string" ? safeKey(payload.status) : "?"} ${parts.join(" ")}`.slice(
    0,
    900,
  );
}

export interface GeminiWebGroundingOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GeminiWebGrounding implements WebGroundingClient {
  readonly modelVersion = WEB_SEARCH_MODEL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: GeminiWebGroundingOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;
  }

  async search(
    request: WebGroundingRequest,
    options: { onCall?: (call: LlmCall) => void } = {},
  ): Promise<GroundedResponse> {
    const report = (call: Omit<LlmCall, "modelVersion">) => {
      try {
        options.onCall?.({ modelVersion: WEB_SEARCH_MODEL, ...call });
      } catch {
        // Muhasebe gozlemcisi hata verdi; saglayici sonucu degismez.
      }
    };
    const body = JSON.stringify({
      model: WEB_SEARCH_MODEL,
      system_instruction: request.systemInstruction,
      input: request.input,
      tools: [{ type: "google_search" }, { type: "url_context" }],
      generation_config: {
        max_output_tokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
        thinking_level: "minimal",
      },
      store: false,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(WEB_SEARCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (caught) {
      report({ httpStatus: null, usage: null });
      const name = (caught as { name?: unknown } | null)?.name;
      throw new LlmError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    if (!response.ok) {
      report({ httpStatus: response.status, usage: null });
      try {
        await response.body?.cancel();
      } catch {
        // Govde zaten kapali.
      }
      throw errorForStatus(response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      report({ httpStatus: response.status, usage: null });
      throw new LlmError("malformed_response", response.status);
    }
    const usage = parseUsage(isRecord(payload) ? payload.usage : undefined);
    // Kullanim, cikti sonradan reddedilse bile kaydedilir (ucret olustu).
    report({
      httpStatus: response.status,
      usage: isRecord(payload) && "usage" in payload ? usage : null,
    });
    return {
      ...parseGroundedPayload(payload),
      usage,
      modelVersion: WEB_SEARCH_MODEL,
      shape: describePayloadShape(payload),
    };
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function getWebGroundingClient(
  env: Env = process.env,
  options: GeminiWebGroundingOptions = {},
): WebGroundingClient {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new LlmError("missing_api_key");
  return new GeminiWebGrounding(apiKey, options);
}

/**
 * Gemini atiflari cogu zaman Google'in sabit yonlendirme adresidir. Gercek
 * magaza adresini ogrenmek icin YALNIZCA bu ana makineye istek atilir
 * (`redirect: "manual"`, yalnizca `Location` okunur, govde okunmaz). Hedef
 * sunucuya hicbir istek yapilmaz: SSRF yuzeyi sabit bir Google adresiyle sinirli.
 */
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const REDIRECT_PATH_PREFIX = "/grounding-api-redirect/";
const REDIRECT_TIMEOUT_MS = 3_000;
const MAX_REDIRECT_LOOKUPS = 16;

export async function resolveCitationUrls(
  citations: readonly GroundingCitation[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const unique = [...new Set(citations.map((c) => c.url))].slice(0, MAX_REDIRECT_LOOKUPS);
  const resolved = await Promise.all(
    unique.map(async (raw): Promise<string | null> => {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return null;
      }
      if (parsed.protocol !== "https:") return null;
      if (parsed.hostname !== GROUNDING_REDIRECT_HOST) return raw;
      if (!parsed.pathname.startsWith(REDIRECT_PATH_PREFIX)) return null;
      try {
        const response = await fetchImpl(parsed.toString(), {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
        });
        const location = response.headers.get("location");
        try {
          await response.body?.cancel();
        } catch {
          // Govde zaten kapali.
        }
        return response.status >= 300 && response.status < 400 ? location : null;
      } catch {
        return null;
      }
    }),
  );
  const safe = new Set<string>();
  for (const url of resolved) {
    const checked = url === null ? null : toSafePublicUrl(url);
    if (checked) safe.add(checked.url);
  }
  return [...safe];
}
