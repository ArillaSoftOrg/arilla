/**
 * Umami yapılandırması (docs/decisions/0116). Saf fonksiyonlar: ağ ve Node
 * bağımlılığı yok; istemci bileşeni `@arilla/core/umami-tracker` alt yolundan
 * import eder.
 *
 * Gizlilik: `UMAMI_API_KEY` yalnızca sunucuda okunur. Hiçbir hata ya da sonuç
 * değeri anahtarı veya adresi taşımaz; yalnızca ortam değişkeninin ADINI söyler.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const UMAMI_ENV = {
  baseUrl: "UMAMI_BASE_URL",
  websiteId: "UMAMI_WEBSITE_ID",
  apiKey: "UMAMI_API_KEY",
  scriptName: "UMAMI_TRACKER_SCRIPT_NAME",
} as const;

const WEBSITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}\.js$/;
const API_KEY_MIN = 16;
const API_KEY_MAX = 512;

export const UMAMI_DEFAULT_SCRIPT = "script.js";

/** Geçerli Umami web sitesi kimliği (UUID) ise küçük harfli kendisi, değilse `null`. */
export function parseWebsiteId(raw: string | undefined | null): string | null {
  const value = raw?.trim().toLowerCase() ?? "";
  return WEBSITE_ID.test(value) ? value : null;
}

/**
 * Umami kökeni: `https://alt.alan.adi`. Yol, sorgu, parça, kullanıcı bilgisi, port
 * ve IP adresi kabul edilmez. Yerel geliştirmede `http://localhost[:port]` serbest.
 */
export function parseBaseUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const host = url.hostname.toLowerCase();
  const local = host === "localhost";
  if (url.protocol === "https:") {
    if (url.port !== "") return null;
  } else if (!(local && url.protocol === "http:")) {
    return null;
  }
  if (!local && (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("["))) return null;
  return url.origin;
}

export function parseScriptName(raw: string | undefined | null): string {
  const value = raw?.trim().toLowerCase() ?? "";
  return SCRIPT_NAME.test(value) ? value : UMAMI_DEFAULT_SCRIPT;
}

export interface UmamiTrackerConfig {
  baseUrl: string;
  websiteId: string;
  scriptUrl: string;
}

/**
 * Tarayıcı izleyicisi: yalnızca web sitesi kimliği ve kök adres geçerliyse.
 * Bu iki değer sır DEĞİLDİR (sayfa kaynağında görünür).
 */
export function umamiTrackerFromEnv(env: Env = process.env): UmamiTrackerConfig | null {
  const baseUrl = parseBaseUrl(env[UMAMI_ENV.baseUrl]);
  const websiteId = parseWebsiteId(env[UMAMI_ENV.websiteId]);
  if (!baseUrl || !websiteId) return null;
  return {
    baseUrl,
    websiteId,
    scriptUrl: `${baseUrl}/${parseScriptName(env[UMAMI_ENV.scriptName])}`,
  };
}

export interface UmamiApiConfig {
  baseUrl: string;
  websiteId: string;
  apiKey: string;
}

export type UmamiApiConfigResult =
  | { status: "ok"; config: UmamiApiConfig }
  | { status: "not_configured" }
  | { status: "invalid"; problems: string[] };

/** Sunucu tarafı okuma ayarı: üç değişkenin hepsi yoksa `not_configured`, kısmen/bozuksa `invalid`. */
export function umamiApiFromEnv(env: Env = process.env): UmamiApiConfigResult {
  const rawBase = env[UMAMI_ENV.baseUrl]?.trim();
  const rawId = env[UMAMI_ENV.websiteId]?.trim();
  const rawKey = env[UMAMI_ENV.apiKey]?.trim();
  if (!rawBase && !rawId && !rawKey) return { status: "not_configured" };

  const problems: string[] = [];
  const baseUrl = parseBaseUrl(rawBase);
  const websiteId = parseWebsiteId(rawId);
  if (!baseUrl) problems.push(UMAMI_ENV.baseUrl);
  if (!websiteId) problems.push(UMAMI_ENV.websiteId);
  const keyOk =
    !!rawKey && rawKey.length >= API_KEY_MIN && rawKey.length <= API_KEY_MAX && !/\s/.test(rawKey);
  if (!keyOk) problems.push(UMAMI_ENV.apiKey);
  if (problems.length > 0 || !baseUrl || !websiteId || !rawKey) {
    return { status: "invalid", problems };
  }
  return { status: "ok", config: { baseUrl, websiteId, apiKey: rawKey } };
}

/** Gönderilen olaylar (docs/events.md, "Umami"). Başka olay gönderilmez. */
export const UMAMI_EVENTS = ["early_access_joined"] as const;
export type UmamiEventName = (typeof UMAMI_EVENTS)[number];

/** Umami'ye gidebilecek olay verisi alanları ve değer süzgeci. */
export const UMAMI_EVENT_DATA_KEYS = ["campaign", "source"] as const;
