import { readAppUrl } from "@arilla/core";

/**
 * Form POST'u kabul eden Route Handler'lar icin kaynak denetimi. Server
 * Action'lar bunu Next'ten hazir alir; Route Handler almaz. Denetim olmazsa
 * baska bir site kullaniciyi saldirganin hesabina sokabilir (login CSRF).
 * `Origin` yoksa (eski tarayici) `Referer` bakilir; ikisi de yoksa reddedilir.
 */
export function isSameOriginPost(request: Request): boolean {
  const allowed = new Set([new URL(request.url).origin]);
  const appUrl = readAppUrl();
  if (appUrl) allowed.add(appUrl);

  const origin = request.headers.get("origin");
  if (origin) return allowed.has(origin);
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return allowed.has(new URL(referer).origin);
  } catch {
    return false;
  }
}
