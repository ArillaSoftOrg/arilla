/**
 * Anonim `session_id` çerezi (giriş yapmamış ziyaretçi; /cerez "zorunlu").
 * Arama duvarı Redis anahtarına (`search-wall:<id>`), tıklama, görsel yükleme
 * ve link isteği satırlarına yazılır. Değeri istemci gönderdiği için yalnızca
 * kanonik küçük harfli UUID kabul edilir: aksi halde istemci her istekte
 * yeni ya da çok uzun anahtar üretebilirdi. Geçersiz değer yok sayılır ve
 * yerine yeni kimlik yazılır.
 *
 * Tarayıcı betikleri bu çereze ihtiyaç duymaz (tüm okuyanlar sunucuda:
 * proxy, Server Action, Server Component, route handler), bu yüzden httpOnly.
 */
export const ANONYMOUS_SESSION_COOKIE = "session_id";
export const ANONYMOUS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Geçerliyse değerin kendisi, değilse `null`. */
export function validAnonymousSessionId(value: string | null | undefined): string | null {
  return typeof value === "string" && CANONICAL_UUID.test(value) ? value : null;
}

export function newAnonymousSessionId(): string {
  return globalThis.crypto.randomUUID();
}

export function anonymousSessionCookieOptions(
  env: Record<string, string | undefined> = process.env,
): {
  path: string;
  maxAge: number;
  sameSite: "lax";
  httpOnly: true;
  secure: boolean;
} {
  return {
    path: "/",
    maxAge: ANONYMOUS_SESSION_MAX_AGE_SECONDS,
    sameSite: "lax",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
  };
}
