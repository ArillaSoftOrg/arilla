/**
 * GA4 ölçümü (karar 0087): tarayıcıya giden her değerin TEK arındırma
 * kaynağı. Saf fonksiyonlar - Node veya DB bağımlılığı yok; istemci bileşeni
 * `@arilla/core/ga4-measurement` alt yolundan import eder.
 *
 * İlke: izin listesi. Bilinmeyen yol, parametre veya değer gönderilmez ya da
 * genel bir şablona indirgenir. Arama metni, token, oturum/sohbet kimliği,
 * e-posta ve telefon GA4'e hiçbir yoldan gitmez.
 */

/** Yalnızca bu olay gönderilir (docs/events.md, "GA4"). */
export const GA4_ALLOWED_EVENTS = ["page_view"] as const;

const MEASUREMENT_ID = /^G-[A-Z0-9]{6,12}$/;

/** Geçerli bir GA4 Measurement ID'si ise kendisi, değilse `null`. */
export function parseMeasurementId(raw: string | undefined | null): string | null {
  const value = raw?.trim().toUpperCase() ?? "";
  return MEASUREMENT_ID.test(value) ? value : null;
}

/** GA4 çerezleri: `_ga` ve `_ga_<ID'nin G- sonrası>`. */
export const GA4_COOKIE_NAME = "_ga";
export const GA4_COOKIE_PREFIX = "_ga_";

export function ga4CookieNames(measurementId: string): string[] {
  return [GA4_COOKIE_NAME, `${GA4_COOKIE_PREFIX}${measurementId.replace(/^G-/, "")}`];
}

/** gtag'in resmi devre dışı bırakma bayrağı: `window['ga-disable-<ID>'] = true`. */
export function ga4DisableKey(measurementId: string): string {
  return `ga-disable-${measurementId}`;
}

/** Çerez ömrü: 13 ay (saniye). /cerez envanteriyle aynı olmalı. */
export const GA4_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 395;

/** Hiç ölçülmeyen yollar: kökün kendisi ve altı. */
const EXCLUDED_ROOTS = ["/yonetim", "/api", "/abonelik-iptali"];
/** Yalnızca ALT yolları ölçülmez (token, geri çağrı, yönetim girişi); kökü ölçülür. */
const EXCLUDED_SUBTREES = ["/giris"];

/** Aynen gönderilen kamu yolları (kimlik ya da kullanıcı girdisi taşımaz). */
const EXACT_PATHS = new Set([
  "/",
  "/affiliate-aciklamasi",
  "/alarmlar",
  "/ara",
  "/ara/gorsel",
  "/ara/link",
  "/blog",
  "/cerez",
  "/erken-erisim",
  "/firsatlar",
  "/gecmis",
  "/geri-bildirim",
  "/giris",
  "/gizlilik",
  "/hakkinda",
  "/hesap",
  "/hesap/gizlilik",
  "/iletisim",
  "/kaydettiklerim",
  "/kesfet",
  "/kosullar",
  "/kvkk-aydinlatma",
  "/ortakliklar",
  "/sirket-bilgileri",
  "/sohbet",
  "/sohbet/yeni",
  "/sss",
  "/trendler",
]);

/** Slug'ı kamu içeriği olan rotalar: slug biçimindeyse aynen, değilse şablon. */
const SLUG_ROUTES = ["/urun", "/blog", "/trendler", "/anket"];

/** Kimlik taşıyan rotalar: her zaman şablon. */
const TEMPLATE_ROUTES: readonly [prefix: string, template: string][] = [
  ["/sohbet", "/sohbet/[id]"],
];

export const OTHER_PATH = "/(diger)";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LONG_DIGITS = /\d{7,}/;
const SLUG_MAX = 120;

/**
 * Arındırılmış yol; ölçülmeyecekse `null`. Sondaki eğik çizgi atılır,
 * büyük/küçük harf korunmaz (rota tanımları küçük harftir).
 */
export function sanitizePagePath(rawPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath.split(/[?#]/)[0] ?? "");
  } catch {
    return OTHER_PATH;
  }
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path.startsWith("/")) return OTHER_PATH;
  const lower = path.toLowerCase();
  if (EXCLUDED_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`))) return null;
  if (EXCLUDED_SUBTREES.some((root) => lower.startsWith(`${root}/`))) return null;
  if (EXACT_PATHS.has(path)) return path;
  const segments = path.split("/").slice(1);
  if (segments.length === 2) {
    const [head, tail] = segments as [string, string];
    const prefix = `/${head}`;
    if (SLUG_ROUTES.includes(prefix)) {
      // 7+ haneli dizi telefon/kimlik olabilir (adres çubuğuna elle yazılmış).
      return SLUG.test(tail) && tail.length <= SLUG_MAX && !LONG_DIGITS.test(tail)
        ? path
        : `${prefix}/[slug]`;
    }
    for (const [routePrefix, template] of TEMPLATE_ROUTES) {
      if (prefix === routePrefix) return template;
    }
  }
  return OTHER_PATH;
}

export const UTM_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

const UTM_VALUE = /^[A-Za-z0-9._\- +]{1,100}$/;
const EMAIL_LIKE = /@|%40/;

/** UTM değeri güvenliyse kendisi; e-posta, uzun rakam dizisi veya garip karakter → `null`. */
export function sanitizeUtmValue(value: string): string | null {
  const trimmed = value.trim();
  if (!UTM_VALUE.test(trimmed) || EMAIL_LIKE.test(trimmed) || LONG_DIGITS.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export interface SanitizedPage {
  /** GA4'ün `page_location`'ı: köken + arındırılmış yol + yalnızca güvenli UTM. */
  location: string;
  path: string;
  /** Belge başlığı yerine gönderilir (başlık arama metni içerebilir). */
  title: string;
}

/** Tam adres → GA4'e gidecek sayfa; ölçülmeyecekse ya da köken farklıysa `null`. */
export function sanitizePage(href: string, origin: string): SanitizedPage | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const path = sanitizePagePath(url.pathname);
  if (path === null) return null;
  const kept = new URLSearchParams();
  for (const name of UTM_PARAMS) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    const clean = sanitizeUtmValue(value);
    if (clean !== null) kept.set(name, clean);
  }
  const query = kept.toString();
  return {
    location: `${url.origin}${path}${query ? `?${query}` : ""}`,
    path,
    title: path,
  };
}

/** Dış yönlendiren: yalnızca köken. İç: arındırılmış adres. Diğer: boş. */
export function sanitizeReferrer(referrer: string, origin: string): string {
  if (!referrer) return "";
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (url.origin === new URL(origin).origin) {
    const page = sanitizePage(url.href, origin);
    return page ? `${url.origin}${page.path}` : "";
  }
  return url.origin;
}

/**
 * `gtag('config', ...)` parametreleri: otomatik sayfa görüntüleme kapalı,
 * Google sinyalleri ve reklam kişiselleştirmesi kapalı, çerez host'a özel.
 */
export function ga4ConfigParams(secure: boolean): Record<string, unknown> {
  return {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_domain: "none",
    cookie_expires: GA4_COOKIE_MAX_AGE_SECONDS,
    cookie_flags: secure ? "SameSite=Lax;Secure" : "SameSite=Lax",
  };
}

/** Rıza durumu: analitik açık, reklamla ilgili her şey kapalı. */
export const GA4_CONSENT_GRANTED = {
  analytics_storage: "granted",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;

export const GA4_CONSENT_DENIED = {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;

/** Rıza açıkken bile CSP'ye eklenecek kökenler (karar 0087 §4). */
export const GA4_SCRIPT_ORIGIN = "https://www.googletagmanager.com";
export const GA4_CONNECT_ORIGINS = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://www.googletagmanager.com",
] as const;
