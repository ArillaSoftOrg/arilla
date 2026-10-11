/**
 * Hatanin dogrulanabilir nedenini belirler (karar 0104). Yalnizca kanita
 * dayanir: veritabani surucu/pooler kodu, `LlmError` kodu, Next'in kendi hata
 * metni gibi bilinen isaretler. Isaret yoksa `unknown` doner; neden uydurulmaz.
 *
 * Bagimlilik yok (istemcide de calisir); `LlmError` ve `RedisUnavailableError`
 * ad/alan uzerinden taninir.
 */
import type { ErrorCode } from "./catalog.ts";

const MAX_CAUSE_DEPTH = 5;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Hata ve `cause` zinciri (drizzle surucu hatasini sarar). */
function chain(error: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let current: unknown = error;
  for (let i = 0; i < MAX_CAUSE_DEPTH; i++) {
    if (typeof current !== "object" || current === null) break;
    const like = current as ErrorLike;
    out.push(like);
    current = like.cause;
  }
  return out;
}

const DB_CAPACITY =
  /EMAXCONNSESSION|max clients reached|too many clients|remaining connection slots/i;
const DB_UNREACHABLE =
  /Connection terminated|timeout exceeded when trying to connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|the database system is (starting up|shutting down)/i;
const DB_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"]);
const DEPLOYMENT =
  /failed to find server action|server action (".*" )?(was )?not found|ChunkLoadError|Loading (CSS )?chunk \S+ failed|Failed to load chunk/i;
const CLIENT_NETWORK = /failed to fetch|networkerror|load failed|network request failed/i;

function fromLlm(like: ErrorLike): ErrorCode | null {
  if (like.name !== "LlmError") return null;
  switch (like.code) {
    case "rate_limited":
      return "ai_rate_limited";
    case "timeout":
      return "ai_timeout";
    case "network":
    case "server_error":
    case "auth":
    case "missing_api_key":
    case "client_error":
      return "ai_unavailable";
    case "incomplete":
    case "malformed_response":
    case "invalid_json":
      return "ai_bad_response";
    default:
      return null;
  }
}

export interface ClassifyOptions {
  /** Istemcide mi calisiyor (ag hatasi yalnizca orada anlamlidir). */
  client?: boolean;
}

/**
 * Hata -> kod. Sira onemli: kesin isaretler genel olanlardan once.
 * Tanimsiz her sey `unknown`.
 */
export function classifyError(error: unknown, options: ClassifyOptions = {}): ErrorCode {
  const links = chain(error);
  if (links.length === 0) return "unknown";

  for (const like of links) {
    if (DB_CAPACITY.test(`${str(like.message)} ${str(like.code)}`) || str(like.code) === "53300") {
      return "db_capacity";
    }
  }
  for (const like of links) {
    const text = str(like.message);
    const code = str(like.code);
    if (like.name === "RedisUnavailableError") return "cache_unavailable";
    const llm = fromLlm(like);
    if (llm) return llm;
    if (DEPLOYMENT.test(`${str(like.name)} ${text}`)) return "deployment_mismatch";
    if (DB_NETWORK_CODES.has(code) || DB_UNREACHABLE.test(text)) return "db_unavailable";
    if (code.startsWith("08") || code === "57P03") return "db_unavailable";
    if (like.name === "AbortError" || like.name === "TimeoutError") return "request_timeout";
  }
  if (options.client) {
    for (const like of links) {
      if (like.name === "TypeError" && CLIENT_NETWORK.test(str(like.message))) return "network";
    }
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    if (nav?.onLine === false) return "network";
  }
  return "unknown";
}
