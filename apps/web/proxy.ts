import { ADMIN_LOGIN_PAGE_PATH, adminLoginPath, isAdminPath } from "@arilla/core/admin-session";
import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousSessionCookieOptions,
  newAnonymousSessionId,
  validAnonymousSessionId,
} from "@arilla/core/anonymous-session";
import { loginPathWithNext } from "@arilla/core/auth-redirect";
import {
  canonicalLinkSearchHref,
  checkLinkSearchUrl,
  isLinkSearchInput,
  LINK_SEARCH_PATH,
} from "@arilla/core/link-input";
import { isProductOpen, isPublicProductPath } from "@arilla/core/product-access";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_PATH_HEADER } from "./app/lib/admin-path-header.ts";

/** `/yonetim/giris` yönetim kabuğunun (ve yetki kapısının) DIŞINDA çizilir. */
const ADMIN_LOGIN_PAGE = "/giris/yonetim";

const USER_ROUTE_PREFIXES = ["/hesap", "/kaydettiklerim", "/alarmlar", "/gecmis"];

/**
 * `middleware.ts` DEĞİL - Next 16'da bu dosya adı deprecated, `proxy.ts`
 * oldu (bkz. node_modules/next/dist/docs/.../file-conventions/proxy.md).
 *
 * Üç bağımsız görev, tek dosyada matcher paylaştıkları için:
 *
 * 1. `/yonetim/*`, `/hesap/*`, `/kaydettiklerim`, `/alarmlar`, `/gecmis`:
 *    yalnızca iyimser kontrol - `session` çerezi yoksa `/giris`'e
 *    yönlendirir. Veritabanına gitmez, rolü doğrulamaz - gerçek kontrol
 *    `app/lib/dal.ts`'teki `requireCapability`/`requireUser` her sayfa, route
 *    handler ve server action'da tekrar yapılır (Next'in kendi rehberi:
 *    proxy tek başına yeterli değil).
 * 2. `/ara/*`: decision 0002'nin sorgu sayacı `session_id`'ye bağlı
 *    (`packages/core/src/auth/search-wall.ts`). Bu çerez `/git/[offerId]/
 *    route.ts`'te zaten var ama yalnızca o rotaya girildiğinde oluşuyor;
 *    `/ara`'ya hiç `/git`'e uğramadan gelen bir ziyaretçi için burada da
 *    garanti edilir. Aynı istekte okunamaz (Next: Server Component render
 *    sırasında çerez YAZILAMAZ) - yalnızca bir SONRAKİ istekte sayaç
 *    çalışmaya başlar; bu, "en az 2-3 sorgu" eşiğiyle zaten uyumludur.
 * 3. `/ara?q=https://...`: arama kutusuna yapıştırılan ürün linki metin
 *    aramasına gitmez, kanonik link araması adresine yönlendirilir
 *    (docs/decisions/0035). Ana sayfa ve /ara formları aynı GET'i yapar;
 *    tek yakınsama noktası burası.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, searchParams } = request.nextUrl;

  // Yönetim alanı (P3, docs/decisions/0044):
  // - `/yonetim/giris` ayrı giriş ekranıdır; adres aynı kalır, sayfa yönetim
  //   layout'unun dışındaki `/giris/yonetim`'den çizilir (kapıya takılmaz).
  // - Oturumu olmayan → `/yonetim/giris` (dönüş yoluyla).
  // - Diğerleri: gerçek yol `x-arilla-path` ile sunucuya iletilir; istemcinin
  //   aynı adlı başlığı burada ezilir. Asıl yetki ve oturum kuralları her
  //   sayfada `requireCapability` ile uygulanır.
  if (pathname === ADMIN_LOGIN_PAGE_PATH) {
    const page = new URL(`${ADMIN_LOGIN_PAGE}${request.nextUrl.search}`, request.url);
    return NextResponse.rewrite(page);
  }
  if (isAdminPath(pathname)) {
    const target = `${pathname}${request.nextUrl.search}`;
    if (!request.cookies.has("session")) {
      return NextResponse.redirect(new URL(adminLoginPath(target), request.url));
    }
    const forwarded = new Headers(request.headers);
    forwarded.set(ADMIN_PATH_HEADER, target);
    return NextResponse.next({ request: { headers: forwarded } });
  }

  // 0. Lansman öncesi ürün kapısı (P2): oturumu olmayan ziyaretçi public
  // ürün yollarından doğrudan landing'e gider (tarayıcılar temiz 307 alır).
  // Oturumu olanın rolü burada bilinmez; asıl denetim her sayfada
  // `requireProductAccess` ile yapılır.
  if (!isProductOpen() && !request.cookies.has("session") && isPublicProductPath(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (pathname === "/ara") {
    const q = searchParams.get("q");
    if (q && isLinkSearchInput(q)) {
      return NextResponse.redirect(new URL(canonicalLinkSearchHref(q), request.url));
    }
  }
  // Kanonik olmayan link araması adresi (izleme parametresi, fragment) tek
  // adımda kanonik adrese: sayfa akış (loading.tsx) içinde yönlendirseydi
  // yanıt 200 olur, yönlendirme istemcide yapılırdı.
  if (pathname === LINK_SEARCH_PATH) {
    const raw = searchParams.get("url");
    const checked = raw ? checkLinkSearchUrl(raw) : null;
    if (raw && checked?.ok && raw !== checked.normalized.url) {
      return NextResponse.redirect(new URL(canonicalLinkSearchHref(raw), request.url));
    }
  }

  const needsSession = USER_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (needsSession && !request.cookies.has("session")) {
    // Girişten sonra aynı sayfaya dönülür; `next` yalnızca kendi yolumuzdur
    // ve her okumada `safeRedirectPath` ile yeniden süzülür.
    const loginPath = loginPathWithNext(`${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(new URL(loginPath, request.url));
  }

  // Eksik ya da kanonik UUID olmayan değer yenisiyle değiştirilir.
  if (
    pathname.startsWith("/ara") &&
    !validAnonymousSessionId(request.cookies.get(ANONYMOUS_SESSION_COOKIE)?.value)
  ) {
    const response = NextResponse.next();
    response.cookies.set(
      ANONYMOUS_SESSION_COOKIE,
      newAnonymousSessionId(),
      anonymousSessionCookieOptions(),
    );
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/yonetim/:path*",
    "/hesap/:path*",
    "/ara/:path*",
    "/urun/:path*",
    "/kesfet",
    "/firsatlar",
    "/trendler/:path*",
    "/git/:path*",
    "/kaydettiklerim",
    "/alarmlar",
    "/gecmis",
  ],
};
