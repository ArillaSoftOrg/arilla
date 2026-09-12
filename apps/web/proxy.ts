import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const USER_ROUTE_PREFIXES = ["/yonetim", "/hesap", "/kaydettiklerim", "/alarmlar", "/gecmis"];

/**
 * `middleware.ts` DEĞİL - Next 16'da bu dosya adı deprecated, `proxy.ts`
 * oldu (bkz. node_modules/next/dist/docs/.../file-conventions/proxy.md).
 *
 * İki bağımsız görev, tek dosyada matcher paylaştıkları için:
 *
 * 1. `/yonetim/*`, `/hesap/*`, `/kaydettiklerim`, `/alarmlar`, `/gecmis`:
 *    yalnızca iyimser kontrol - `session` çerezi yoksa `/giris`'e
 *    yönlendirir. Veritabanına gitmez, rolü doğrulamaz - gerçek kontrol
 *    `app/lib/dal.ts`'teki `requireRole`/`requireUser` her sayfa, route
 *    handler ve server action'da tekrar yapılır (Next'in kendi rehberi:
 *    proxy tek başına yeterli değil).
 * 2. `/ara/*`: decision 0002'nin sorgu sayacı `session_id`'ye bağlı
 *    (`packages/core/src/auth/search-wall.ts`). Bu çerez `/git/[offerId]/
 *    route.ts`'te zaten var ama yalnızca o rotaya girildiğinde oluşuyor;
 *    `/ara`'ya hiç `/git`'e uğramadan gelen bir ziyaretçi için burada da
 *    garanti edilir. Aynı istekte okunamaz (Next: Server Component render
 *    sırasında çerez YAZILAMAZ) - yalnızca bir SONRAKİ istekte sayaç
 *    çalışmaya başlar; bu, "en az 2-3 sorgu" eşiğiyle zaten uyumludur.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const needsSession = USER_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (needsSession && !request.cookies.has("session")) {
    return NextResponse.redirect(new URL("/giris", request.url));
  }

  if (pathname.startsWith("/ara") && !request.cookies.has("session_id")) {
    const response = NextResponse.next();
    response.cookies.set("session_id", randomUUID(), {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/yonetim/:path*",
    "/hesap/:path*",
    "/ara/:path*",
    "/kaydettiklerim",
    "/alarmlar",
    "/gecmis",
  ],
};
