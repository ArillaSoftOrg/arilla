/**
 * Kaba istek bağlamı (docs/decisions/0049 §9). Ham user agent ve IP hiçbir
 * yeni tabloya yazılmaz; buradan yalnızca küçük sabit sınıflar çıkar:
 *
 * - `deviceClass`: mobile / tablet / desktop / other
 * - `browserFamily`: chrome / safari / firefox / edge / samsung / opera / other
 * - `countryCode`: barındırma platformunun eklediği ülke başlığı
 *   (`x-vercel-ip-country`), yalnızca iki büyük harf. IP'den konum
 *   ÇIKARILMAZ; şehir/bölge/koordinat toplanmaz. Yalnızca güvenlik
 *   bağlamıdır (tanınmayan giriş); analitikte, kişiselleştirmede ve
 *   pazarlamada kullanılmaz.
 *
 * Bağımlılıksız ve bilinçli olarak kaba: amaç cihaz parmak izi değil,
 * "telefondan mı bilgisayardan mı" düzeyinde bir ipucu.
 */
import type { BrowserFamily, DeviceClass } from "@arilla/db";
import type { HeaderReader } from "../auth/client-ip.ts";

export interface RequestContext {
  deviceClass: DeviceClass | null;
  browserFamily: BrowserFamily | null;
  countryCode: string | null;
}

export const EMPTY_REQUEST_CONTEXT: RequestContext = {
  deviceClass: null,
  browserFamily: null,
  countryCode: null,
};

/** Platformun eklediği ülke başlığı. İstemci bu başlığı Vercel'de yazamaz. */
export const COUNTRY_HEADER = "x-vercel-ip-country";

const MAX_UA_LENGTH = 512;
const BOT = /bot|crawler|spider|crawling|headless|slurp|facebookexternalhit|preview/i;

export function classifyDevice(userAgent: string | null | undefined): DeviceClass | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, MAX_UA_LENGTH);
  if (BOT.test(ua)) return "other";
  if (/ipad|tablet|kindle|silk|playbook/i.test(ua)) return "tablet";
  if (/android/i.test(ua) && !/mobile/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return "mobile";
  if (/windows nt|macintosh|mac os x|x11|linux|cros/i.test(ua)) return "desktop";
  return "other";
}

export function classifyBrowser(userAgent: string | null | undefined): BrowserFamily | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, MAX_UA_LENGTH);
  // Sıra önemli: Edge/Opera/Samsung UA'ları "Chrome" ve "Safari" de içerir;
  // Chrome UA'sı "Safari" içerir.
  if (/edg(e|a|ios)?\//i.test(ua)) return "edge";
  if (/opr\/|opera/i.test(ua)) return "opera";
  if (/samsungbrowser/i.test(ua)) return "samsung";
  if (/firefox|fxios/i.test(ua)) return "firefox";
  if (/chrome|crios|chromium/i.test(ua)) return "chrome";
  if (/safari/i.test(ua) && /version\//i.test(ua)) return "safari";
  return "other";
}

/** Yalnızca `^[A-Z]{2}$`. Vercel'in bilinmeyen için kullandığı `XX` ve `T1` (Tor) NULL olur. */
export function normalizeCountryCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase();
  if (!trimmed || !/^[A-Z]{2}$/.test(trimmed)) return null;
  if (trimmed === "XX") return null;
  return trimmed;
}

export function requestContextFromHeaders(headers: HeaderReader): RequestContext {
  const userAgent = headers.get("user-agent");
  return {
    deviceClass: classifyDevice(userAgent),
    browserFamily: classifyBrowser(userAgent),
    countryCode: normalizeCountryCode(headers.get(COUNTRY_HEADER)),
  };
}
