/**
 * Lansman oncesi urun kapisi - tek karar noktasi. Web katmani (`dal.ts`
 * `requireProductAccess`, route handler'lar, proxy) ve ileride MCP/API ayni
 * fonksiyonu kullanir; kural app klasorune yazilmaz (CLAUDE.md kural 6).
 *
 * - `PRODUCT_ACCESS=open`: urun herkese acik (lansman).
 * - Tanimsiz ya da baska her deger: KAPALI (fail-closed). Yalnizca
 *   `product.preview` yetenegi olan roller (moderator, admin) gecer.
 * - Normal kullanici erken erisim listesinde olsa da gecemez; liste kaydi
 *   (`early_access`) kapiyi acmaz.
 *
 * Bu dosya veritabanina ve Redis'e dokunmaz; proxy de icerebilsin diye
 * yalnizca rol ve ortam degiskeni okur.
 */
import { hasCapability } from "../admin/capabilities.ts";
import { safeRedirectPath } from "../auth/safe-redirect.ts";
import type { UserRole } from "../auth/types.ts";

/** Normal kullanicinin giris sonrasi ve kapida yonlendirildigi basari ekrani. */
export const EARLY_ACCESS_PATH = "/erken-erisim";

/**
 * Anonim ziyaretcinin proxy'de dogrudan ana sayfaya (erken erisim
 * landing'i) yonlendirildigi public urun yollari. Giris gerektiren urun
 * sayfalari (`/kaydettiklerim`, ...) proxy'de zaten `/giris`'e gider; tum
 * urun sayfalari ayrica sunucuda `requireProductAccess` ile denetlenir.
 */
export const PUBLIC_PRODUCT_PATH_PREFIXES = ["/urun", "/kesfet", "/firsatlar", "/ara", "/git"];

type Env = Readonly<Record<string, string | undefined>>;

export function isProductOpen(env: Env = process.env): boolean {
  return env.PRODUCT_ACCESS?.trim().toLowerCase() === "open";
}

export function canAccessProduct(
  user: { role: UserRole } | null | undefined,
  env: Env = process.env,
): boolean {
  if (isProductOpen(env)) return true;
  return user ? hasCapability(user.role, "product.preview") : false;
}

/** Kapidan gecemeyen istek nereye gider: anonim -> landing, girisli -> basari ekrani. */
export function productAccessRedirect(user: { role: UserRole } | null | undefined): string {
  return user ? EARLY_ACCESS_PATH : "/";
}

/**
 * Giris sonrasi hedef. Urune erisebilen (lansman sonrasi herkes, oncesinde
 * yalnizca yetkili roller) guvenli `next`'e doner; digerleri her girişte
 * basari ekranina.
 */
export function postAuthRedirect(
  user: { role: UserRole },
  next: unknown,
  env: Env = process.env,
): string {
  return canAccessProduct(user, env) ? safeRedirectPath(next) : EARLY_ACCESS_PATH;
}

export function isPublicProductPath(pathname: string): boolean {
  return PUBLIC_PRODUCT_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
