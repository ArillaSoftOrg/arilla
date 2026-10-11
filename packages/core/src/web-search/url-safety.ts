/**
 * Internet sonucu adresleri icin guvenlik (docs/decisions/0102).
 *
 * Sunucumuz bu adreslere ASLA istek atmaz (tek istisna: Google'in sabit
 * grounding yonlendirme ana makinesi, bkz. `grounding-client.ts`); adresler
 * yalnizca kullaniciya imzali yonlendirmeyle sunulur. Yine de ic ag hedefleri,
 * kimlik bilgisi tasiyan ve sema/port hileli adresler reddedilir.
 */

const TRACKING_PARAMS = new Set([
  "gclid",
  "gad_source",
  "gad_campaignid",
  "fbclid",
  "msclkid",
  "srsltid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_ga",
]);

/** Urun olmayan, arama/sosyal/forum alanlari: bunlar magaza sayfasi degildir. */
const BLOCKED_HOST_SUFFIXES = [
  "google.com",
  "google.com.tr",
  "googleusercontent.com",
  "gstatic.com",
  "googleapis.com",
  "bing.com",
  "yandex.com",
  "yandex.com.tr",
  "duckduckgo.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "tiktok.com",
  "wikipedia.org",
  "reddit.com",
  "sikayetvar.com",
];

const PRIVATE_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
];

const SEARCH_LIKE_PATH =
  /(?:^|\/)(?:ara|arama|search|s|sr|kategori|category|categories|c|tag|etiket|liste)(?:\/|$)/;
const SEARCH_LIKE_PARAM = new Set(["q", "query", "search", "s", "keyword", "k", "arama"]);

function bareHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

function isIpLiteral(hostname: string): boolean {
  return (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[")
  );
}

export function isBlockedHost(host: string): boolean {
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export interface SafeUrl {
  /** Kanonik tam adres (https, izleme parametresiz, parcasiz). */
  url: string;
  /** `www.` atilmis kucuk harf ana makine. */
  host: string;
  /** Ana makine + yol (sorgu yok), kucuk harf, sondaki `/` atilmis: eslestirme anahtari. */
  key: string;
}

/**
 * Genel, https, standart portlu, kimlik bilgisiz bir alisveris adresi mi.
 * Gecerliyse kanonik halini doner; degilse `null`.
 */
export function toSafePublicUrl(input: unknown): SafeUrl | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.port !== "" && parsed.port !== "443") return null;
  const host = bareHost(parsed.hostname);
  if (host.length < 4 || host.length > 253 || !host.includes(".")) return null;
  if (isIpLiteral(parsed.hostname) || isIpLiteral(host)) return null;
  if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || /(?:^|\.)-|-(?:\.|$)|\.\./.test(host)) return null;
  if (!/\.[a-z]{2,24}$/.test(host)) return null;
  if (isBlockedHost(host)) return null;

  const kept: [string, string][] = [];
  for (const [name, value] of parsed.searchParams) {
    const lower = name.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) continue;
    kept.push([name, value]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const search = new URLSearchParams(kept).toString();
  const path = parsed.pathname.replace(/\/+$/, "");
  const url = `https://${host}${path}${search ? `?${search}` : ""}`;
  if (url.length > 2048) return null;
  return { url, host, key: `${host}${path.toLowerCase()}` };
}

/**
 * Yol/sorgu bir arama ya da liste sayfasina benziyor mu, kok sayfa mi. Bunlar
 * "urun sayfasi" sayilmaz. Sezgiseldir: asil dogrulama URL Context + model
 * `pageType` beyanindan gelir; bu yalnizca bariz yanlislari ele.
 */
export function looksLikeProductPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
  if (path === "") return false;
  if (SEARCH_LIKE_PATH.test(path)) return false;
  for (const name of parsed.searchParams.keys()) {
    if (SEARCH_LIKE_PARAM.has(name.toLowerCase())) return false;
  }
  return true;
}
