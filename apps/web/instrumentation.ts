import { reportError } from "@arilla/core/errors";

/**
 * Yakalanmamis sunucu hatalarini siniflar ve guvenli loglar (karar 0104).
 * Next'in `digest`'i referans kimligi olur: kullanicinin hata ekraninda
 * gordugu kod ile bu log satiri eslesir. Yalnizca rota KALIBI (`routePath`)
 * yazilir; gercek yol ve sorgu (kisisel veri icerebilir) yazilmaz.
 */
export function onRequestError(
  error: unknown,
  _request: unknown,
  context: { routePath?: string; routeType?: string },
): void {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest?: unknown }).digest ?? "")
      : "";
  reportError(error, {
    surface: `${context.routeType ?? "route"}:${context.routePath ?? "?"}`,
    ...(digest ? { digest } : {}),
  });
}
