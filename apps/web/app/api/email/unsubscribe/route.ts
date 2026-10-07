import { UNSUBSCRIBE_PAGE_PATH, unsubscribeByToken } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { clientIp } from "../../../lib/client-ip.ts";

/**
 * RFC 8058 tek tık abonelik iptali (`List-Unsubscribe-Post: List-Unsubscribe=
 * One-Click`, docs/decisions/0048). Posta sağlayıcısının sunucusu bu adrese
 * POST eder; istek bizim sitemizden gelmez, bu yüzden aynı-köken denetimi
 * BİLEREK yok — yetki URL'deki token'dır ve yalnızca o teslimin sahibinin
 * pazarlama iznini geri alabilir. İdempotent. Token ve adres loglanmaz.
 */
export async function POST(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  const result = await unsubscribeByToken(getDatabase(), token, {
    ip: clientIp(request.headers),
  });
  const headers = { "Cache-Control": "no-store" };
  if (result.status === "invalid") return new Response(null, { status: 400, headers });
  return new Response(null, { status: 200, headers });
}

/** GET hiçbir şey değiştirmez (bağlantı tarayıcıları); insan onay sayfasına gider. */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const target = new URL(UNSUBSCRIBE_PAGE_PATH, url.origin);
  const token = url.searchParams.get("t");
  if (token) target.searchParams.set("t", token);
  return new Response(null, {
    status: 303,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
