import { describe, expect, it } from "vitest";
import {
  oppositeTheme,
  parseTheme,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE_SECONDS,
  themeCookieAssignment,
} from "./lib/theme.ts";

describe("parseTheme (karar 0092)", () => {
  it("yalnizca light/dark kabul eder", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("bilinmeyen, bos ya da eksik deger elle secim sayilmaz (cihaz tercihi)", () => {
    for (const value of [undefined, null, "", "system", "Dark", " dark", "dark;x=1"]) {
      expect(parseTheme(value)).toBeNull();
    }
  });
});

describe("oppositeTheme", () => {
  it("iki tema arasinda gecer", () => {
    expect(oppositeTheme("light")).toBe("dark");
    expect(oppositeTheme("dark")).toBe("light");
  });
});

describe("themeCookieAssignment", () => {
  it("tum site icin, bir yillik, SameSite=Lax tercih cerezi yazar", () => {
    const value = themeCookieAssignment("dark", { secure: false });
    expect(value).toBe(
      `${THEME_COOKIE}=dark; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`,
    );
    expect(THEME_COOKIE_MAX_AGE_SECONDS).toBe(31_536_000);
  });

  it("https'te Secure ekler", () => {
    expect(themeCookieAssignment("light", { secure: true })).toMatch(/; Secure$/);
  });
});
