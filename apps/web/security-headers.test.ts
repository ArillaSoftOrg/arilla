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
    expect(securityHeaderOptionsFromEnv({ NODE_ENV: "production", VERCEL: "1" })).toEqual(PROD);
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
});
