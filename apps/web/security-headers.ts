/**
 * Güvenlik başlıkları (docs/decisions/0050). `next.config.ts` `headers()`
 * bunları her yanıta koyar; `/yonetim` dahil tek merkez.
 *
 * İçerik politikası, sitenin bugün gerçekten yüklediğine göre yazılmıştır:
 * - Betik, stil, font yalnızca kendi kökenimizden (CLAUDE.md: üçüncü taraf
 *   CDN yok). Next App Router hidrasyon için satır içi betik basar; nonce
 *   her sayfayı dinamik yapacağından `'unsafe-inline'` bilerek kalır.
 *   `'unsafe-eval'` yalnızca `next dev` (hızlı yenileme) içindir.
 * - Ürün görselleri mağazaların kendi `https:` adreslerinden gelir; görsel
 *   aramada önizleme `blob:`.
 * - Çerçeveleme tamamen kapalı (`frame-ancestors 'none'` + eski tarayıcılar
 *   için `X-Frame-Options: DENY`): yönetim ekranı başka bir siteye gömülüp
 *   tıklatılamaz.
 * - `form-action`: Google ve Apple girişleri sağlayıcıya yönlendirir;
 *   tarayıcılar form gönderiminden sonraki yönlendirmeyi de denetler.
 * - HSTS yalnızca üretimde; alt alan adları ve preload listesi bilerek yok
 *   (HTTPS'siz bir alt alan adı kilitlenmesin).
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

export interface SecurityHeaderOptions {
  /** `next dev` ise true: `'unsafe-eval'` ve HMR websocket'i. */
  development: boolean;
  /** Üretim HTTPS dağıtımı ise true: HSTS ve `upgrade-insecure-requests`. */
  production: boolean;
}

export const OAUTH_FORM_TARGETS = ["https://accounts.google.com", "https://appleid.apple.com"];

export function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      ["'self'", "'unsafe-inline'", ...(options.development ? ["'unsafe-eval'"] : [])],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...(options.development ? ["ws:", "wss:"] : [])]],
    ["frame-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'", ...OAUTH_FORM_TARGETS]],
    ["frame-ancestors", ["'none'"]],
  ];
  const parts = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (options.production) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function securityHeaders(options: SecurityHeaderOptions): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
  if (options.production) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  }
  return headers;
}

/**
 * Yönetim alanı ayrıca dizine eklenmez. (`Cache-Control` burada verilmez:
 * Next üretimde config'teki değeri ezer; yönetim sayfaları zaten dinamik.)
 */
export const ADMIN_EXTRA_HEADERS: SecurityHeader[] = [
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/**
 * Adresinde tek kullanımlık token taşıyan yollar (e-posta giriş bağlantısı,
 * abonelik iptali). Genel `Referrer-Policy`'yi `no-referrer` ile ezer: route
 * ve sayfa bunu zaten ister, config başlığı onu bastırmasın. Next'te aynı
 * anahtar için listede SONRAKİ eşleşme kazanır.
 */
export const TOKEN_URL_PATHS = ["/giris/dogrula", "/abonelik-iptali", "/api/email/unsubscribe"];

/** `next.config.ts` `headers()` girdisi. Sıra önemli: özel girdiler sonra. */
export function securityHeaderRoutes(options: SecurityHeaderOptions) {
  return [
    { source: "/:path*", headers: securityHeaders(options) },
    { source: "/yonetim", headers: ADMIN_EXTRA_HEADERS },
    { source: "/yonetim/:path*", headers: ADMIN_EXTRA_HEADERS },
    ...TOKEN_URL_PATHS.map((source) => ({
      source,
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    })),
  ];
}

/** Çalışma ortamından seçenekler. Vercel önizlemesi de HTTPS'tir. */
export function securityHeaderOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecurityHeaderOptions {
  const production = env.NODE_ENV === "production";
  return { development: !production, production: production && env.VERCEL === "1" };
}
