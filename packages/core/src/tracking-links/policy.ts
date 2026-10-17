/**
 * Takip bağlantıları: slug, hedef ve yönlendirme kuralları (docs/decisions/0115).
 * Saf fonksiyonlar: veritabanı, Redis ve ağ yok. Hem yönetimdeki yazma yolu hem
 * yönlendirme (önbellekten okunan değer dahil) AYNI doğrulamadan geçer.
 */
import { isIP } from "node:net";
import { readAppUrl } from "../config/app-url.ts";

export class TrackingLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingLinkValidationError";
  }
}

export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const NAME_MAX = 80;
export const TARGET_MAX = 2000;

/**
 * Sistem rotaları: bu adlar slug OLAMAZ ve kendi alanımızdaki bir hedefin ilk yol
 * parçası ancak bunlardan biri olabilir. Liste `apps/web/app` klasörlerinden
 * okunan bir testle (`reserved-slugs.test.ts`, web) güncel tutulur: yeni üst
 * düzey rota eklenip buraya yazılmazsa test kırılır.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Mevcut üst düzey rotalar (apps/web/app)
  "abonelik-iptali",
  "affiliate-aciklamasi",
  "alarmlar",
  "anket",
  "api",
  "ara",
  "blog",
  "cerez",
  "davet",
  "erken-erisim",
  "firsatlar",
  "gecmis",
  "geri-bildirim",
  "giris",
  "git",
  "gizlilik",
  "hakkinda",
  "hesap",
  "iletisim",
  "kaydettiklerim",
  "kesfet",
  "kosullar",
  "kvkk-aydinlatma",
  "ortakliklar",
  "sirket-bilgileri",
  "sitemaps",
  "sohbet",
  "sss",
  "teklifler",
  "trendler",
  "urun",
  "yonetim",
  // next.config.ts yönlendirme kaynakları (yönlendirme rotadan önce çalışır)
  "kullanim-kosullari",
  "cerez-politikasi",
  "fonts",
  "ways",
  // docs/routes.md'de planlı ya da ayrılmış
  "alternatif",
  "kategori",
  "marka",
  "trend",
  "koleksiyon",
  "yaratici",
  "creator",
  // Genel olarak ele geçirilmemesi gereken adlar
  "admin",
  "login",
  "logout",
  "cikis",
  "kayit",
  "signup",
  "sign-in",
  "auth",
  "oauth",
  "callback",
  "hesabim",
  "profil",
  "ayarlar",
  "settings",
  "health",
  "status",
  "mcp",
  "static",
  "assets",
  "public",
  "analytics",
  "umami",
  "q",
  "t",
  "l",
  "robots",
  "sitemap",
  "favicon",
  "manifest",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

export function normalizeSlug(raw: unknown): string {
  if (typeof raw !== "string") throw new TrackingLinkValidationError("Slug gerekli.");
  const slug = raw.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new TrackingLinkValidationError(
      "Slug 1-40 karakter olmalı: küçük harf (a-z), rakam ve tire; tire ile başlayıp bitemez.",
    );
  }
  if (isReservedSlug(slug)) {
    throw new TrackingLinkValidationError("Bu ad bir sistem adresi; başka bir slug seç.");
  }
  return slug;
}

/** Kontrol karakterleri ve yön değiştiren Unicode karakterleri (listede sahtecilik / Trojan source). */
function hasUnsafeChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") throw new TrackingLinkValidationError("Ad gerekli.");
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new TrackingLinkValidationError(`Ad 1-${NAME_MAX} karakter olmalı.`);
  }
  // Kontrol karakteri ve yön değiştiren Unicode karakterleri (yönetim listesinde sahtecilik).
  if (hasUnsafeChar(name)) {
    throw new TrackingLinkValidationError("Ad geçersiz karakter içeriyor.");
  }
  return name;
}

/** Kaynak / kampanya: boş → null; aksi halde `utm_*` için güvenli kısa etiket. */
export function normalizeLabel(raw: unknown, field: "Kaynak" | "Kampanya"): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new TrackingLinkValidationError(`${field} geçersiz.`);
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (!LABEL_PATTERN.test(value)) {
    throw new TrackingLinkValidationError(
      `${field} 1-40 karakter olmalı: küçük harf, rakam, tire ve alt çizgi.`,
    );
  }
  return value;
}

export interface TargetPolicy {
  /** Göreli hedeflerin çözüldüğü köken (`APP_URL`); istek `Host` başlığı kullanılmaz. */
  appOrigin: string;
  /** Mutlak hedefte izinli ana makine adları (küçük harf). */
  allowedHosts: ReadonlySet<string>;
}

/**
 * `APP_URL` ana makinesi + `www` eşi + `TRACKING_LINK_EXTRA_HOSTS`. Ek alan adları
 * yalnızca ManiCepte'nin kendi alan adları olmalıdır: harici bir mağazaya çıkış
 * `click` kaydı gerektirir (CLAUDE.md kural 8) ve bu tabloda yoktur.
 */
export function targetPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): TargetPolicy {
  const appOrigin = readAppUrl(env);
  if (!appOrigin) throw new Error("APP_URL tanimli degil; takip baglantilari hedefi dogrulanamaz.");
  const host = new URL(appOrigin).hostname.toLowerCase();
  const hosts = new Set<string>([host]);
  if (host.startsWith("www.")) hosts.add(host.slice(4));
  else if (!isIP(host) && host !== "localhost" && host.includes(".")) hosts.add(`www.${host}`);
  for (const extra of (env.TRACKING_LINK_EXTRA_HOSTS ?? "").split(",")) {
    const value = extra.trim().toLowerCase();
    if (value && /^[a-z0-9.-]+$/.test(value) && value.includes(".") && !isIP(value)) {
      hosts.add(value);
    }
  }
  return { appOrigin, allowedHosts: hosts };
}

/** Kendi alanımızdaki yolun ilk parçası sistem rotası (ya da kök) olmalı. */
function checkOwnPath(pathname: string): void {
  if (pathname === "/") return;
  const first = pathname.split("/")[1]?.toLowerCase() ?? "";
  if (!RESERVED_SLUGS.has(first)) {
    throw new TrackingLinkValidationError(
      "Hedef bir sistem sayfası olmalı (örn. /, /trendler/…, /blog/…). Başka bir kısa bağlantıya ya da bilinmeyen yola yönlendirilemez.",
    );
  }
}

/**
 * Hedefi doğrular ve saklanacak biçime getirir. Mutlak adres: `https`, kullanıcı
 * bilgisi/port/IP yok, ana makine izinli listede. Göreli: `/` ile başlar, `//` ve
 * `\` yok. Hata mesajı hedefin kendisini yansıtmaz.
 */
export function normalizeTarget(raw: unknown, policy: TargetPolicy): string {
  if (typeof raw !== "string") throw new TrackingLinkValidationError("Hedef adres gerekli.");
  const value = raw.trim();
  if (value === "") throw new TrackingLinkValidationError("Hedef adres gerekli.");
  if (value.length > TARGET_MAX) {
    throw new TrackingLinkValidationError(`Hedef adres en fazla ${TARGET_MAX} karakter olabilir.`);
  }
  // URL ayrıştırıcısı `\`yi `/` yapar ve boşluk/kontrol karakterlerini sessizce atar:
  // ham metinde reddedilir ki ayrıştırma sonrası sürpriz kalmasın.
  if (/\s/.test(value) || value.includes("\\") || hasUnsafeChar(value)) {
    throw new TrackingLinkValidationError("Hedef adres boşluk ya da geçersiz karakter içeriyor.");
  }

  if (value.startsWith("/")) {
    if (value.startsWith("//")) {
      throw new TrackingLinkValidationError("Hedef adres geçersiz.");
    }
    const parsed = new URL(value, policy.appOrigin);
    if (parsed.origin !== policy.appOrigin) {
      throw new TrackingLinkValidationError("Hedef adres geçersiz.");
    }
    checkOwnPath(parsed.pathname);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TrackingLinkValidationError("Hedef adres geçerli bir URL değil.");
  }
  const appUrl = new URL(policy.appOrigin);
  const localDev = appUrl.protocol === "http:" && appUrl.hostname === "localhost";
  const schemeOk = parsed.protocol === "https:" || (localDev && parsed.protocol === "http:");
  if (!schemeOk) {
    throw new TrackingLinkValidationError("Hedef adres https ile başlamalı.");
  }
  if (parsed.username || parsed.password) {
    throw new TrackingLinkValidationError("Hedef adres kullanıcı bilgisi içeremez.");
  }
  const host = parsed.hostname.toLowerCase();
  if (isIP(host) || host.startsWith("[")) {
    throw new TrackingLinkValidationError("Hedef adres IP adresi olamaz.");
  }
  if (parsed.port !== "" && !(localDev && host === "localhost")) {
    throw new TrackingLinkValidationError("Hedef adres özel port içeremez.");
  }
  if (!policy.allowedHosts.has(host)) {
    throw new TrackingLinkValidationError(
      "Hedef yalnızca ManiCepte alan adlarından biri olabilir.",
    );
  }
  checkOwnPath(parsed.pathname);
  return parsed.toString();
}

export interface RedirectInput {
  targetUrl: string;
  source: string | null;
  campaign: string | null;
}

/**
 * Yönlendirme adresini kurar. Saklı hedef (ya da önbellekten gelen değer) burada
 * YENİDEN doğrulanır; geçersizse `null` (çağıran 404 verir, yönlendirmez).
 * `source`/`campaign` doluysa `utm_source`, `utm_campaign` ve `utm_medium=link`
 * eklenir; hedefte zaten varsa dokunulmaz.
 */
export function buildRedirectLocation(input: RedirectInput, policy: TargetPolicy): string | null {
  let stored: string;
  try {
    stored = normalizeTarget(input.targetUrl, policy);
  } catch {
    return null;
  }
  const url = new URL(stored, policy.appOrigin);
  if (input.source && !url.searchParams.has("utm_source")) {
    url.searchParams.set("utm_source", input.source);
  }
  if (input.campaign && !url.searchParams.has("utm_campaign")) {
    url.searchParams.set("utm_campaign", input.campaign);
  }
  if ((input.source || input.campaign) && !url.searchParams.has("utm_medium")) {
    url.searchParams.set("utm_medium", "link");
  }
  return url.toString();
}

/** Denetim kaydı için hedefin yalnız ana makine adı + yolu (sorgu ve parça YAZILMAZ). */
export function auditTarget(targetUrl: string): string {
  try {
    const url = new URL(targetUrl, "https://placeholder.invalid");
    const host = url.hostname === "placeholder.invalid" ? "" : url.hostname;
    return `${host}${url.pathname}`.slice(0, 200);
  } catch {
    return "";
  }
}
