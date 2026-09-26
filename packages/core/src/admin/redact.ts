/**
 * Yönetim ekranında gösterilen serbest metin ve adreslerden gizli bilgi
 * ayıklama. Feed adresleri ve hata metinleri (Python istisnaları) sorgu
 * dizisinde API anahtarı, imzalı token ya da affiliate kimliği taşıyabilir;
 * kullanıcı adres satırında `kullanıcı:parola@` olabilir.
 *
 * Kural: adresin yalnızca şema + ana makine + yol kısmı gösterilir. Sorgu
 * dizisi, parça (#) ve kimlik bilgisi atılır.
 */

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi;

/** `https://user:pass@host/path?token=x#y` → `https://host/path`. Geçersizse `null`. */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const redacted = url.search ? "?…" : "";
    return `${url.protocol}//${url.host}${url.pathname}${redacted}`;
  } catch {
    return null;
  }
}

/** Yalnızca ana makine: `www.ornek.com`. */
export function urlHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

/**
 * Görsel `src`'si için: adres OLDUĞU GİBİ döner (CDN imzası sorgu dizisinde
 * olabilir, görsel yüklenmeli) ama yalnızca http(s) ise. `javascript:` ya da
 * `data:` gibi şemalar hiçbir zaman öğeye yazılmaz.
 */
export function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Serbest metindeki her adresi `safeUrl` biçimine indirir; uzun metni kırpar. */
export function redactText(text: string | null | undefined, maxLength = 2000): string | null {
  if (!text) return null;
  const redacted = text.replace(URL_PATTERN, (match) => safeUrl(match) ?? "[adres]");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
