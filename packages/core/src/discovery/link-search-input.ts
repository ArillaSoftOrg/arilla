/**
 * Link araması girdisi (docs/decisions/0031) — hafif, bağımlılıksız modül.
 * `proxy.ts` bunu `@arilla/core/link-input` alt yolundan içe aktarır; bu
 * yüzden yalnızca `normalize-url.ts`'e bağlıdır (veritabanı, Redis yok).
 *
 * İki giriş noktası TEK kanonik adrese yakınsar:
 *
 *   arama kutusu   /ara?q=https://magaza.com/urun/x      ─┐
 *   önek kısayolu  /https://magaza.com/urun/x             ─┼─► /ara/link?url=<kodlanmış kanonik adres>
 *   doğrudan       /ara/link?url=https%3A%2F%2F...        ─┘
 *
 * Buradaki denetim YAZIM düzeyidir ve savunma derinliği içindir: asıl SSRF
 * kararı (DNS çözümü, her yönlendirme adımı) sayfayı getiren Python
 * worker'ındadır (`services/ingest/collect/link/safe_http.py`). Kurallar o
 * dosyadaki `check_url` ile aynı tutulur.
 */
import { InvalidUrlError, type NormalizedUrl, normalizeUrl } from "./normalize-url.ts";

export const LINK_SEARCH_PATH = "/ara/link";

/** Adres çubuğu / paylaşım için makul üst sınır; Python tarafıyla aynı. */
export const MAX_LINK_URL_LENGTH = 2048;

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
];

/** Arama kutusuna yazılan metin bir link araması mı? Yalnızca http(s) ile başlayan. */
export function isLinkSearchInput(raw: string | null | undefined): boolean {
  return typeof raw === "string" && /^\s*https?:\/\/\S/i.test(raw);
}

/** Kanonik link araması adresi. `url` her zaman tam kodlanır: `?`, `&`, `#` kaybolmaz. */
export function linkSearchHref(url: string): string {
  return `${LINK_SEARCH_PATH}?url=${encodeURIComponent(url.trim())}`;
}

/**
 * Önek kısayolunun yol parçalarından dış adresi geri kurar. Üç biçim gelir,
 * hepsi aynı sonuca döner:
 *
 *  - Next yoldaki tekrar eden bölüleri tekilleştirir: tarayıcıda
 *    `/https://magaza.com/x` yazılan adres `["https:", "magaza.com", "x"]` olur;
 *  - tekilleştirilmemişse boş parçalı `["https:", "", "magaza.com", "x"]`;
 *  - ana sayfa arama kutusu linki tek parça kodlar
 *    (`/https%3A%2F%2Fmagaza.com%2Fx`): `["https://magaza.com/x"]`.
 *
 * Parçalar çağıranda çözülmüş (`decodeURIComponent`) olmalıdır. Şema yoksa
 * `null` — o zaman bu bir link değil, gerçek bir 404'tür.
 */
export function urlFromPrefixSegments(segments: readonly string[], search: string): string | null {
  const match = /^(https?):\/*(.+)$/is.exec(segments.join("/"));
  const scheme = match?.[1]?.toLowerCase();
  const rest = match?.[2];
  if (!scheme || !rest) return null;
  const query = search && search !== "?" ? (search.startsWith("?") ? search : `?${search}`) : "";
  // Tek parça kodlanmış adres kendi sorgusunu taşıyabilir; ikisi birleşir.
  const suffix = query && rest.includes("?") ? `&${query.slice(1)}` : query;
  return `${scheme}://${rest}${suffix}`;
}

/**
 * Girdiden kanonik link araması adresi: adres geçerliyse izleme parametresiz
 * kanonik biçimi, değilse olduğu gibi (sayfa hata durumunu gösterir). Proxy
 * bununla tek adımda, gerçek bir HTTP yönlendirmesiyle kanonik adrese gider.
 */
export function canonicalLinkSearchHref(raw: string): string {
  const checked = checkLinkSearchUrl(raw);
  return linkSearchHref(checked.ok ? checked.normalized.url : raw);
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export type LinkUrlCheck =
  | { ok: true; normalized: NormalizedUrl }
  | { ok: false; reason: "invalid" | "blocked" };

/**
 * Link araması için adresi doğrular ve normalize eder. Kullanıcıya
 * gösterilecek iki durum var: biçim bozuk (`invalid`) ya da iç ağa / izin
 * verilmeyen bir hedefe gidiyor (`blocked`). IP literalleri tümüyle
 * reddedilir: WHATWG URL ayrıştırıcısı `http://2130706433/` gibi biçimleri
 * zaten `127.0.0.1`e çevirir, ürün sayfaları da IP ile yayınlanmaz.
 */
export function checkLinkSearchUrl(raw: string): LinkUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LINK_URL_LENGTH) return { ok: false, reason: "invalid" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "blocked" };

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || isIpv4Literal(host)) return { ok: false, reason: "blocked" };
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "blocked" };
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: "blocked" };

  try {
    return { ok: true, normalized: normalizeUrl(trimmed) };
  } catch (error) {
    if (error instanceof InvalidUrlError) return { ok: false, reason: "invalid" };
    throw error;
  }
}
