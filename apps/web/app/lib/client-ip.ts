import { type HeaderReader, resolveClientIp } from "@arilla/core";

/**
 * Güvenilir istemci IP'si (giriş oran sınırı, rıza kaydı). Karar core'da:
 * `x-forwarded-for`'un istemcinin yazabildiği ilk elemanına güvenilmez.
 */
export function clientIp(headers: HeaderReader): string | null {
  return resolveClientIp(headers);
}
