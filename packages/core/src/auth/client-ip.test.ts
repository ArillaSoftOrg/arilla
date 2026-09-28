import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip.ts";
import { authRateLimitKeys } from "./rate-limit.ts";

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null };
}

describe("resolveClientIp", () => {
  it("ignores a spoofed first x-forwarded-for entry outside Vercel", () => {
    const h = headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" });
    expect(resolveClientIp(h, {})).toBe("203.0.113.9");
  });

  it("keeps local development working with a single entry", () => {
    expect(resolveClientIp(headers({ "x-forwarded-for": "::1" }), {})).toBe("::1");
    expect(resolveClientIp(headers({}), {})).toBeNull();
  });

  it("prefers the platform set x-real-ip on Vercel", () => {
    const h = headers({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "1.1.1.1, 198.51.100.4" });
    expect(resolveClientIp(h, { VERCEL: "1" })).toBe("198.51.100.4");
  });

  it("falls back to the last x-forwarded-for entry on Vercel", () => {
    const h = headers({ "x-forwarded-for": "1.1.1.1, 198.51.100.4" });
    expect(resolveClientIp(h, { VERCEL: "1" })).toBe("198.51.100.4");
  });

  it("rejects values that are not IP addresses", () => {
    expect(resolveClientIp(headers({ "x-forwarded-for": "1.1.1.1, not-an-ip" }), {})).toBeNull();
    expect(resolveClientIp(headers({ "x-real-ip": "evil" }), { VERCEL: "1" })).toBeNull();
  });

  it("feeds the same rate limit key regardless of a spoofed prefix", () => {
    const direct = resolveClientIp(headers({ "x-forwarded-for": "203.0.113.9" }), {});
    const spoofed = resolveClientIp(headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }), {});
    expect(authRateLimitKeys({ email: "a@b.test", ip: spoofed }).ipKey).toBe(
      authRateLimitKeys({ email: "a@b.test", ip: direct }).ipKey,
    );
  });
});
