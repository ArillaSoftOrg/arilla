/**
 * Giris sonrasi donus adresi (`next`). Yalnizca ayni kokenli goreli yol
 * kabul edilir; digeri her durumda `/`'e duser (open redirect yok).
 *
 * Kurallar:
 * - `/` ile baslar, `//` ile baslamaz (protokol-goreli dis adres).
 * - Ters bolu, bosluk ya da kontrol karakteri icermez: tarayicilar `/\evil`
 *   adresini `//evil` gibi yorumlar.
 * - Ayristirildiktan sonra koken degismez (sahte bir koke gore cozulur).
 * - `/giris` ve `/yonetim/giris` altina donulmez: giris ekranina geri donmek
 *   dongu olurdu.
 */
export const DEFAULT_REDIRECT_PATH = "/";
const MAX_REDIRECT_LENGTH = 512;
const PROBE_ORIGIN = "https://arilla.invalid";

export function safeRedirectPath(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_REDIRECT_PATH;
  if (raw.length === 0 || raw.length > MAX_REDIRECT_LENGTH) return DEFAULT_REDIRECT_PATH;
  if (!raw.startsWith("/") || raw.startsWith("//")) return DEFAULT_REDIRECT_PATH;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: kontrol karakterleri bilerek reddedilir.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_REDIRECT_PATH;

  let parsed: URL;
  try {
    parsed = new URL(raw, PROBE_ORIGIN);
  } catch {
    return DEFAULT_REDIRECT_PATH;
  }
  if (parsed.origin !== PROBE_ORIGIN) return DEFAULT_REDIRECT_PATH;
  // Giris ekranlarina (normal ve yonetim) geri donmek dongu olurdu.
  for (const loginPath of ["/giris", "/yonetim/giris"]) {
    if (parsed.pathname === loginPath || parsed.pathname.startsWith(`${loginPath}/`)) {
      return DEFAULT_REDIRECT_PATH;
    }
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** `/giris` adresine guvenli `next` ekler; varsayilan yol icin parametre eklenmez. */
export function loginPathWithNext(next: unknown, base = "/giris"): string {
  const path = safeRedirectPath(next);
  return path === DEFAULT_REDIRECT_PATH ? base : `${base}?next=${encodeURIComponent(path)}`;
}
