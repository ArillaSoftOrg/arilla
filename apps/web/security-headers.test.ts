import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  securityHeaderOptionsFromEnv,
  securityHeaderRoutes,
  securityHeaders,
} from "./security-headers.ts";

const PROD = { development: false, production: true };
const DEV = { development: true, production: false };

function directive(csp: string, name: string): string[] | undefined {
  const part = csp.split("; ").find((p) => p.startsWith(`${name} `) || p === name);
  return part?.split(" ").slice(1);
}

function header(list: { key: string; value: string }[], key: string): string | undefined {
  return list.find((h) => h.key === key)?.value;
}

describe("güvenlik başlıkları", () => {
  it("üretim: CSP, çerçeve yasağı, nosniff, referrer, permissions, HSTS", () => {
    const headers = securityHeaders(PROD);
    expect(header(headers, "X-Frame-Options")).toBe("DENY");
    expect(header(headers, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(headers, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header(headers, "Permissions-Policy")).toContain("camera=()");
    expect(header(headers, "Strict-Transport-Security")).toBe("max-age=31536000");

    const csp = header(headers, "Content-Security-Policy") ?? "";
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("üretimde eval ve üçüncü taraf betik/font kaynağı yok", () => {
    const csp = contentSecurityPolicy(PROD);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive(csp, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, "font-src")).toEqual(["'self'"]);
    expect(directive(csp, "connect-src")).toEqual(["'self'"]);
    // Joker kaynak yok (görsel hariç: mağaza görselleri https).
    for (const name of ["default-src", "script-src", "style-src", "connect-src", "frame-src"]) {
      expect(directive(csp, name)).not.toContain("*");
      expect(directive(csp, name)).not.toContain("https:");
    }
  });

  it("Google ve Apple girişi form-action'da izinli", () => {
    const formAction = directive(contentSecurityPolicy(PROD), "form-action");
    expect(formAction).toContain("'self'");
    expect(formAction).toContain("https://accounts.google.com");
    expect(formAction).toContain("https://appleid.apple.com");
  });

  it("geliştirme: HSTS yok, eval ve HMR websocket var", () => {
    const headers = securityHeaders(DEV);
    expect(header(headers, "Strict-Transport-Security")).toBeUndefined();
    const csp = header(headers, "Content-Security-Policy") ?? "";
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "connect-src")).toContain("ws:");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("HSTS yalnızca Vercel üretim derlemesinde", () => {
    expect(securityHeaderOptionsFromEnv({ NODE_ENV: "production", VERCEL: "1" })).toEqual({
      ...PROD,
      ga4: false,
    });
    expect(securityHeaderOptionsFromEnv({ NODE_ENV: "production" }).production).toBe(false);
    expect(securityHeaderOptionsFromEnv({ NODE_ENV: "development" }).development).toBe(true);
  });

  it("yönetim yolları genel başlıkları ve noindex'i alır", () => {
    const routes = securityHeaderRoutes(PROD);
    const all = routes.find((r) => r.source === "/:path*");
    expect(header(all?.headers ?? [], "Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    for (const source of ["/yonetim", "/yonetim/:path*"]) {
      const admin = routes.find((r) => r.source === source);
      expect(header(admin?.headers ?? [], "X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });

  it("token taşıyan yollar no-referrer alır ve genel girdiden SONRA gelir", () => {
    const routes = securityHeaderRoutes(PROD);
    const globalIndex = routes.findIndex((r) => r.source === "/:path*");
    for (const source of ["/giris/dogrula", "/abonelik-iptali", "/api/email/unsubscribe"]) {
      const index = routes.findIndex((r) => r.source === source);
      expect(index).toBeGreaterThan(globalIndex);
      expect(header(routes[index]?.headers ?? [], "Referrer-Policy")).toBe("no-referrer");
    }
  });

  // Karar 0087: GA4 yalnızca geçerli ölçüm kimliğiyle ve yönetim alanı hariç.
  it("GA4 kimliği yoksa ya da geçersizse CSP genişlemez", () => {
    for (const value of [undefined, "", "UA-12345-1", "G-<script>", "g-abc"]) {
      const options = securityHeaderOptionsFromEnv({
        NODE_ENV: "production",
        VERCEL: "1",
        GA4_MEASUREMENT_ID: value,
      });
      expect(options.ga4).toBe(false);
      const csp = contentSecurityPolicy(options);
      expect(directive(csp, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
      expect(directive(csp, "connect-src")).toEqual(["'self'"]);
    }
  });

  it("GA4 etkinken yalnızca Google ölçüm kökenleri eklenir", () => {
    const options = securityHeaderOptionsFromEnv({
      NODE_ENV: "production",
      VERCEL: "1",
      GA4_MEASUREMENT_ID: "G-ABC123DEF4",
    });
    expect(options.ga4).toBe(true);
    const csp = contentSecurityPolicy(options);
    expect(directive(csp, "script-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "https://www.googletagmanager.com",
    ]);
    expect(directive(csp, "connect-src")).toEqual([
      "'self'",
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://www.googletagmanager.com",
    ]);
    // Diğer yönergeler değişmez: font, çerçeve, form ve nesne kuralları aynı.
    expect(directive(csp, "font-src")).toEqual(["'self'"]);
    expect(directive(csp, "frame-src")).toEqual(["'self'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
  });

  it("GA4 etkinken yönetim alanı Google kökenleri OLMAYAN CSP ile ezilir", () => {
    const options = { ...PROD, ga4: true };
    const routes = securityHeaderRoutes(options);
    const globalIndex = routes.findIndex((r) => r.source === "/:path*");
    for (const source of ["/yonetim", "/yonetim/:path*"]) {
      const index = routes.findIndex((r) => r.source === source);
      expect(index).toBeGreaterThan(globalIndex);
      const csp = header(routes[index]?.headers ?? [], "Content-Security-Policy") ?? "";
      expect(csp).not.toContain("googletagmanager");
      expect(csp).not.toContain("google-analytics");
      expect(csp).not.toContain("analytics.google");
      expect(directive(csp, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    }
    // GA4 kapalıyken yönetim girdisi CSP taşımaz (genel CSP zaten dar).
    const plain = securityHeaderRoutes(PROD).find((r) => r.source === "/yonetim");
    expect(header(plain?.headers ?? [], "Content-Security-Policy")).toBeUndefined();
  });
});
