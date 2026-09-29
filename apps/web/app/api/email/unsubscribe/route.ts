import { unsubscribeByToken } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { clientIp } from "../../../lib/client-ip.ts";

/**
 * RFC 8058 tek tık abonelik iptali (`List-Unsubscribe-Post`). Posta
 * sağlayıcısının sunucusu `List-Unsubscribe=One-Click` gövdesiyle POST eder;
 * istek bizim sitemizden gelmez, bu yüzden `isSameOriginPost` BİLEREK
 * uygulanmaz — yetki URL'deki iptal token'ıdır ve bu token yalnızca listeden
 * çıkarabilir. İşlem idempotenttir. Token ve adres loglanmaz.
 */
export async function POST(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  const result = await unsubscribeByToken(getDatabase(), token, {
    ip: clientIp(request.headers),
  });
  if (result.status === "invalid") {
    return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/** GET bir şey değiştirmez; insan tıklaması onay sayfasına gider. */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const target = new URL("/abonelik-iptali", url.origin);
  const token = url.searchParams.get("t");
  if (token) target.searchParams.set("t", token);
  return Response.redirect(target, 303);
}
