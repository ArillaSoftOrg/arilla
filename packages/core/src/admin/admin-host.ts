/**
 * Yonetim konsolunun ayri ana makinesi (docs/decisions/0056, Adim 1). Saf
 * fonksiyonlar; `apps/web/proxy.ts`, `app/lib/dal.ts`, Google giris rotalari
 * ve yonetim API'si yalnizca bunlari cagirir.
 *
 * `ADMIN_HOST` (ornek `admin.manicepte.com`, yerelde `admin.localhost:3000`):
 *
 * - Tanimsiz -> "shared": bugunku davranis, konsol her ana makinede `/yonetim`.
 * - Gecerli -> "split": konsol, yonetim API'si ve yonetim yetenekleri YALNIZCA
 *   bu ana makinede calisir. Asil kazanc: oturum cerezi host-only oldugu icin
 *   yonetim oturumu public sitedekinden ayridir; ayrica public sitede bir XSS,
 *   yoneticinin public oturumuyla server action tetikleyemez - yetenek kapisi
 *   ana makineyi de denetler (server action'lar hangi yola POST edilirse
 *   edilsin calisir, yol yonlendirmesi tek basina yetmez).
 * - Gecersiz -> "invalid": kapali kalir (fail-closed). Konsol hicbir ana
 *   makinede acilmaz, public site etkilenmez.
 *
 * Ana makine karsilastirmasi `Host` basligiyla yapilir. Tarayici bu basligi
 * kendisi yazar; sahte `Host` gonderen biri kurbanin cerezini tasiyamaz.
 */
import { readAppUrl } from "../config/app-url.ts";
import { type DeployEnv, isProductionDeploy } from "../config/deploy-env.ts";
import { ADMIN_HOME_PATH, ADMIN_LOGIN_PAGE_PATH, isAdminPath } from "./session-policy.ts";

export type AdminHostPolicy =
  | { readonly mode: "shared" }
  | { readonly mode: "split"; readonly host: string; readonly origin: string }
  | { readonly mode: "invalid" };

type Env = DeployEnv & { readonly ADMIN_HOST?: string | undefined };

/** `host` ya da `host:port`; kucuk harf, protokol/yol/kimlik bilgisi yok. */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function normalizeHost(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  return value ? value : null;
}

export function adminHostPolicy(env: Env = process.env): AdminHostPolicy {
  const host = normalizeHost(env.ADMIN_HOST?.replace(/^["']|["']$/g, ""));
  if (!host) return { mode: "shared" };
  if (host.length > 253 || !HOST_PATTERN.test(host)) return { mode: "invalid" };
  const hostname = host.replace(/:\d+$/, "");
  const production = isProductionDeploy(env);
  // Uretimde yerel ana makine ya da port: yanlis yapilandirma.
  if (production && (isLocalHostname(hostname) || hostname !== host)) return { mode: "invalid" };
  // Uretimde her zaman https; disinda public siteyle ayni sema (yerelde TLS yok).
  const http = !production && /^["']?http:\/\//i.test(env.APP_URL?.trim() ?? "");
  return { mode: "split", host, origin: `${http ? "http" : "https"}://${host}` };
}

/** Istek yonetim konsoluna izinli ana makineden mi geliyor. */
export function isAdminRequestHost(policy: AdminHostPolicy, requestHost: string | null): boolean {
  if (policy.mode === "shared") return true;
  if (policy.mode === "invalid") return false;
  return normalizeHost(requestHost) === policy.host;
}

/** Yonetim API'si (`/api/yonetim/*`, karar 0117). */
export const ADMIN_API_PREFIX = "/api/yonetim";
/** Yonetim girisinin `proxy.ts`'teki rewrite hedefi. */
export const ADMIN_LOGIN_RENDER_PATH = "/giris/yonetim";
/**
 * Yonetim ana makinesinde acik giris yollari: yalnizca Google (karar 0056
 * uygulamasi). Apple/telefon/e-posta burada yoktur; dogrulanmis e-postayla
 * hesap baglama yuzeyi yonetim girisinde tek saglayiciya iner.
 */
const ADMIN_HOST_AUTH_PATHS = new Set(["/giris/google", "/giris/google/callback"]);

function isAdminApiPath(pathname: string): boolean {
  return pathname === ADMIN_API_PREFIX || pathname.startsWith(`${ADMIN_API_PREFIX}/`);
}

/** Next ic dosyalari ve `public/` altindaki uzantili dosyalar (ikon, font). */
function isAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_next/") || /\/[^/]+\.[a-z0-9]{2,5}$/i.test(pathname);
}

export type AdminHostRoute =
  | { readonly action: "continue" }
  | { readonly action: "redirect"; readonly location: string; readonly status: 307 | 308 }
  | { readonly action: "not_found" };

/**
 * `proxy.ts`'in ana makine karari. `location` her zaman mutlak adrestir:
 * Next'in `NextResponse.redirect(URL)` yardimcisi `localhost` adreslerini
 * istegin ana makinesiyle degistirir (yerelde yonlendirme dongusu), bu
 * yuzden proxy `Location` basligini dogrudan yazar.
 *
 * split, yonetim ana makinesi: `/` -> `/yonetim`; konsol, yonetim API'si,
 * Google girisi ve dosyalar gecer; diger her yol public siteye 308.
 * split, diger ana makineler: konsol ve yonetim girisi yonetim ana makinesine
 * 308; yonetim API'si 404 (POST'u baska kokene tasimanin anlami yok).
 * invalid: konsol ve API her yerde 404. shared: dokunulmaz.
 */
export function routeAdminHost(
  policy: AdminHostPolicy,
  input: {
    host: string | null;
    pathname: string;
    search: string;
    publicOrigin?: string | undefined;
  },
): AdminHostRoute {
  const { pathname, search } = input;
  if (policy.mode === "shared") return { action: "continue" };
  const adminArea =
    isAdminPath(pathname) || isAdminApiPath(pathname) || pathname === ADMIN_LOGIN_RENDER_PATH;
  if (policy.mode === "invalid") {
    return adminArea ? { action: "not_found" } : { action: "continue" };
  }

  if (isAdminRequestHost(policy, input.host)) {
    if (pathname === "/") {
      return { action: "redirect", location: `${policy.origin}${ADMIN_HOME_PATH}`, status: 307 };
    }
    if (adminArea || ADMIN_HOST_AUTH_PATHS.has(pathname) || isAssetPath(pathname)) {
      return { action: "continue" };
    }
    return input.publicOrigin
      ? { action: "redirect", location: `${input.publicOrigin}${pathname}${search}`, status: 308 }
      : { action: "not_found" };
  }

  if (isAdminApiPath(pathname)) return { action: "not_found" };
  if (isAdminPath(pathname)) {
    return { action: "redirect", location: `${policy.origin}${pathname}${search}`, status: 308 };
  }
  if (pathname === ADMIN_LOGIN_RENDER_PATH) {
    return {
      action: "redirect",
      location: `${policy.origin}${ADMIN_LOGIN_PAGE_PATH}${search}`,
      status: 308,
    };
  }
  return { action: "continue" };
}

/**
 * Google girisinin `redirect_uri` kokeni: yonetim ana makinesindeki giris
 * kendi adresine doner (cerez o ana makineye yazilsin), digerleri `APP_URL`.
 * `appUrl` cagiran tarafindan `requireAppUrl()` ile verilir.
 */
export function authOriginForHost(
  policy: AdminHostPolicy,
  requestHost: string | null,
  appUrl: () => string,
): string {
  return policy.mode === "split" && isAdminRequestHost(policy, requestHost)
    ? policy.origin
    : appUrl();
}

/** Public sitenin kokeni; yalnizca split'te gerekir (aksi halde okunmaz). */
export function publicOriginFor(
  policy: AdminHostPolicy,
  env: Env = process.env,
): string | undefined {
  return policy.mode === "split" ? readAppUrl(env) : undefined;
}

/** Konsoldaki "Siteye don" baglantisi: split'te public sitenin koku. */
export function publicSiteHref(policy: AdminHostPolicy, env: Env = process.env): string {
  const origin = publicOriginFor(policy, env);
  return origin ? `${origin}/` : "/";
}

/** Yonetim ana makinesinde yalnizca Google gosterilir (bkz. `ADMIN_HOST_AUTH_PATHS`). */
export function isAdminHostRequest(policy: AdminHostPolicy, requestHost: string | null): boolean {
  return policy.mode === "split" && isAdminRequestHost(policy, requestHost);
}
