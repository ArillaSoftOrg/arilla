import { describe, expect, it } from "vitest";
import { buildLoginUrl } from "./request-login-link.ts";

describe("buildLoginUrl", () => {
  it("points to the confirmation page with the token", () => {
    const url = new URL(buildLoginUrl("https://arilla.example", "tok_123"));
    expect(url.origin).toBe("https://arilla.example");
    expect(url.pathname).toBe("/giris/dogrula");
    expect(url.searchParams.get("token")).toBe("tok_123");
    expect(url.searchParams.has("next")).toBe(false);
  });

  it("carries only a safe next path", () => {
    const safe = new URL(buildLoginUrl("https://arilla.example", "t", "/ara?q=ruj"));
    expect(safe.searchParams.get("next")).toBe("/ara?q=ruj");

    for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", "/"]) {
      const url = new URL(buildLoginUrl("https://arilla.example", "t", unsafe));
      expect(url.searchParams.has("next")).toBe(false);
    }
  });
});
