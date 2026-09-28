/**
 * Lansman oncesi urun kapisi - tek karar noktasi. Web katmani (`dal.ts`
 * `requireProductAccess`, route handler'lar, proxy) ve ileride MCP/API ayni
 * fonksiyonu kullanir; kural app klasorune yazilmaz (CLAUDE.md kural 6).
 *
 * - `PRODUCT_ACCESS=open`: urun herkese acik (lansman).
 * - Tanimsiz ya da baska her deger: KAPALI (fail-closed). Yalnizca
 *   `product.preview` yetenegi olan rol (admin, karar 0043) gecer.
 *   Moderator yonetim konsolunu kullanir ama urun kilidini asamaz.
 * - Normal kullanici erken erisim listesinde olsa da gecemez; liste kaydi
 *   (`early_access`) kapiyi acmaz.
 *
 * Bu dosya veritabanina ve Redis'e dokunmaz; proxy de icerebilsin diye
 * yalnizca rol ve ortam degiskeni okur.
 */
import { hasCapability } from "../admin/capabilities.ts";
import { loginPathWithNext, safeRedirectPath } from "../auth/safe-redirect.ts";
import type { UserRole } from "../auth/types.ts";

/** Normal kullanicinin giris sonrasi ve kapida yonlendirildigi basari ekrani. */
export const EARLY_ACCESS_PATH = "/erken-erisim";

/**
 * Landing'deki "Erken erişime katıl" eyleminin hedefi: mevcut giris akisi,
 * mevcut guvenli `next` ile. Kayit girisin kendisinde yazilir
 * (`createSessionForUser`); normal kullanici `postAuthRedirect` ile zaten
 * basari ekranina gider, `next` yalnizca niyeti acik tutar.
 */
export const EARLY_ACCESS_LOGIN_PATH = loginPathWithNext(EARLY_ACCESS_PATH);

/**
 * Sade "Admin Girişi" baglantisi: ayni giris akisi, `next=/yonetim`. Ayri
 * parola, gizli adres ya da belirtec YOK. Yetki girisin ardindan sunucuda
 * rolden okunur (`postAuthRedirect` + `/yonetim`'in `requireCapability`'si);
 * yetkisiz hesap `next`'e hic donmez, basari ekranina gider. Giristen once
 * hicbir e-postanin yonetici olup olmadigi belli olmaz.
 */
export const ADMIN_LOGIN_PATH = loginPathWithNext("/yonetim");

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

/** Yonetim konsolu koku; `/yonetim`'in kendi yetki kapisi (`requireCapability`) degismez. */
export const ADMIN_CONSOLE_PATH = "/yonetim";

function isAdminConsolePath(path: string): boolean {
  return (
    path === ADMIN_CONSOLE_PATH ||
    path.startsWith(`${ADMIN_CONSOLE_PATH}/`) ||
    path.startsWith(`${ADMIN_CONSOLE_PATH}?`)
  );
}

/** Yonetim konsolu personeli (moderator, admin) - urun erisiminden bagimsiz. */
function isConsoleStaff(role: UserRole): boolean {
  return hasCapability(role, "admin.access");
}

/**
 * Giriste erken erisim listesine yazilacak mi: urune erisemeyen normal
 * hesaplar. Personel (moderator dahil) listeye yazilmaz (P2).
 */
export function shouldJoinEarlyAccess(user: { role: UserRole }, env: Env = process.env): boolean {
  return !canAccessProduct(user, env) && !isConsoleStaff(user.role);
}

/** Kapidan gecemeyen istek nereye gider: anonim -> landing, girisli -> basari ekrani. */
export function productAccessRedirect(user: { role: UserRole } | null | undefined): string {
  return user ? EARLY_ACCESS_PATH : "/";
}

/**
 * Giris sonrasi hedef. Urune erisebilen (lansman sonrasi herkes, oncesinde
 * yalnizca admin) guvenli `next`'e doner. Urune erisemeyen personel
 * (lansman oncesi moderator) yalnizca yonetim konsoluna doner - guvenli
 * `next` konsol altindaysa o, degilse konsol koku. Digerleri her giriste
 * basari ekranina. P3: urune erisebilen ama yonetim yetkisi olmayan
 * kullanici (lansman sonrasi normal kullanici) `next` konsol altinda olsa
 * da oraya gonderilmez; 404'e degil ana sayfaya doner.
 */
export function postAuthRedirect(
  user: { role: UserRole },
  next: unknown,
  env: Env = process.env,
): string {
  if (canAccessProduct(user, env)) {
    const target = safeRedirectPath(next);
    return isAdminConsolePath(target) && !isConsoleStaff(user.role) ? "/" : target;
  }
  if (isConsoleStaff(user.role)) {
    const safe = safeRedirectPath(next);
    return isAdminConsolePath(safe) ? safe : ADMIN_CONSOLE_PATH;
  }
  return EARLY_ACCESS_PATH;
}

export function isPublicProductPath(pathname: string): boolean {
  return PUBLIC_PRODUCT_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
