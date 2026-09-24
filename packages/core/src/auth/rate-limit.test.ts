import { describe, expect, it } from "vitest";
import { authRateLimitKeys } from "./rate-limit.ts";

describe("authRateLimitKeys()", () => {
  it("e-postayi ve IP'yi anahtara duz yazmaz", () => {
    const { emailKey, ipKey } = authRateLimitKeys({
      email: "Ayse@Example.test",
      ip: "203.0.113.7",
    });
    expect(emailKey).toMatch(/^ratelimit:auth:email:[0-9a-f]{64}$/);
    expect(ipKey).toMatch(/^ratelimit:auth:ip:[0-9a-f]{64}$/);
    expect(emailKey.toLowerCase()).not.toContain("ayse");
    expect(ipKey).not.toContain("203.0.113.7");
  });

  it("e-posta buyuk/kucuk harf ve bosluktan bagimsiz ayni anahtari uretir", () => {
    const a = authRateLimitKeys({ email: " Ayse@Example.test ", ip: null });
    const b = authRateLimitKeys({ email: "ayse@example.test", ip: null });
    expect(a.emailKey).toBe(b.emailKey);
    expect(a.ipKey).toBeNull();
  });
});
