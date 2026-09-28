import { describe, expect, it } from "vitest";
import { loginPathWithNext, safeRedirectPath } from "./safe-redirect.ts";

describe("safeRedirectPath", () => {
  it.each([
    ["/", "/"],
    ["/kaydettiklerim", "/kaydettiklerim"],
    ["/ara?q=ruj&sayfa=2", "/ara?q=ruj&sayfa=2"],
    ["/urun/abc#fiyat", "/urun/abc#fiyat"],
    ["/yonetim/magazalar", "/yonetim/magazalar"],
  ])("accepts same-origin relative path %s", (raw, expected) => {
    expect(safeRedirectPath(raw)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    42,
    "",
    "kaydettiklerim",
    "https://evil.example/",
    "http:/evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "/\\/evil.example",
    "/ /evil",
    "/\t/evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
    "/giris",
    "/giris/dogrula?token=x",
    `/${"a".repeat(600)}`,
  ])("falls back to / for %j", (raw) => {
    expect(safeRedirectPath(raw)).toBe("/");
  });

  it("normalizes dot segments without leaving the origin", () => {
    expect(safeRedirectPath("/a/../../b")).toBe("/b");
  });
});

describe("loginPathWithNext", () => {
  it("adds an encoded next only for a non-default safe path", () => {
    expect(loginPathWithNext("/ara?q=ruj")).toBe("/giris?next=%2Fara%3Fq%3Druj");
    expect(loginPathWithNext("/")).toBe("/giris");
    expect(loginPathWithNext("//evil.example")).toBe("/giris");
  });
});
