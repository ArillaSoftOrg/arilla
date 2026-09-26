/**
 * URL normalizasyonu ve `external_id` türetimi.
 *
 * `services/ingest/collect/link/urls.py`'nin TypeScript yansıması - birebir
 * aynı davranmalı. Kök catch-all (D4) bu fonksiyonla bir `offer`'ın zaten
 * katalogda olup olmadığını salt-okunur kontrol eder; Python worker aynı
 * URL'yi kendi `urls.normalize()`'ı ile kataloğa yazdığında ikisi FARKLI
 * `external_id` üretirse offer asla bulunamaz. Bu yüzden aşağıdaki sabitler
 * ve mantık kasıtlı olarak birebir kopya - tek bir davranış farkı bile
 * sessizce "hep bulunamadı" durumuna düşer.
 *
 * Aynı ürün linki farklı izleme parametreleriyle yapıştırıldığında AYNI
 * `external_id`'yi vermelidir:
 *
 *     https://magaza.example/urun/canta?utm_source=instagram
 *     https://www.magaza.example/urun/canta?fbclid=abc
 *     https://magaza.example/urun/canta#yorumlar
 */

const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
  "source",
  "trk",
  "spm",
  "sid",
  "affiliate",
  "aff_id",
  "tag",
  "campaign",
]);

const TRACKING_PREFIXES = ["utm_", "pk_", "_hs", "adj_"];

const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443 };

export class InvalidUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUrlError";
  }
}

export interface NormalizedUrl {
  /** Getirilecek adres — şema + gerçek host (`www.` dahil) (+port) + yol + anlamlı parametreler. */
  url: string;
  /** `merchant.domain` ile eşleşen host. Port İÇERMEZ. */
  domain: string;
  /** `offer.external_id` — merchant içinde tekil. */
  externalId: string;
  /** `robots.txt`in bulunduğu kök: şema + host + port. */
  origin: string;
}

function isTracking(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    TRACKING_PARAMS.has(lowered) || TRACKING_PREFIXES.some((prefix) => lowered.startsWith(prefix))
  );
}

export function normalizeUrl(raw: string): NormalizedUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new InvalidUrlError(`geçersiz URL: ${raw}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUrlError(`yalnızca http/https desteklenir: ${parsed.protocol || "şema yok"}`);
  }

  // Kimlik bilgisi ve port host'un parçası değil. `www.` yalnızca KİMLİKTEN
  // düşer (`domain`); getirilen adres gerçek host'u korur - apeks alan adı
  // çözülmeyen mağazalar var (docs/decisions/0031).
  const fetchHost = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const host = fetchHost.startsWith("www.") ? fetchHost.slice(4) : fetchHost;
  if (!host || !host.includes(".")) {
    throw new InvalidUrlError(`geçersiz alan adı: ${host}`);
  }

  // Anlamlı parametreler korunur ve sıralanır; sıra değişikliği kimliği
  // değiştirmemeli. Python tarafı `keep_blank_values=False` ile boş
  // değerli parametreleri de düşürüyor (`urls.py`) - aynısı burada.
  const query = [...parsed.searchParams.entries()]
    .filter(([name, value]) => value !== "" && !isTracking(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // Sondaki bölü işareti tek başına farklı bir sayfa anlamına gelmiyor.
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const encoded = new URLSearchParams(query).toString();

  const port = parsed.port ? Number(parsed.port) : null;
  const defaultPort = DEFAULT_PORT[parsed.protocol];
  const netloc = port === null || port === defaultPort ? fetchHost : `${fetchHost}:${port}`;

  const url = `${parsed.protocol}//${netloc}${path}${encoded ? `?${encoded}` : ""}`;
  const externalId = encoded ? `${path}?${encoded}` : path;

  return {
    url,
    domain: host,
    externalId,
    origin: `${parsed.protocol}//${netloc}`,
  };
}
