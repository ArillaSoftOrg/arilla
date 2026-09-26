import { describe, expect, it } from "vitest";
import { InvalidUrlError, normalizeUrl } from "./normalize-url.ts";

describe("normalizeUrl", () => {
  it("gives the same external_id for the same product across tracking-param variants", () => {
    const a = normalizeUrl("https://magaza.example/urun/canta?utm_source=instagram");
    const b = normalizeUrl("https://www.magaza.example/urun/canta?fbclid=abc");
    const c = normalizeUrl("https://magaza.example/urun/canta#yorumlar");

    expect(a.externalId).toBe("/urun/canta");
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toBe(c.externalId);
    expect(a.domain).toBe("magaza.example");
  });

  it("strips the www prefix from the domain", () => {
    expect(normalizeUrl("https://www.example.com/x").domain).toBe("example.com");
  });

  it("keeps the real host in the fetched url (apex may not resolve)", () => {
    const result = normalizeUrl("https://WWW.Example.com/x?utm_source=a#b");
    expect(result.url).toBe("https://www.example.com/x");
    expect(result.origin).toBe("https://www.example.com");
    expect(result.externalId).toBe("/x");
  });

  it("keeps non-tracking query params, sorted", () => {
    const first = normalizeUrl("https://example.com/p?b=2&a=1");
    const second = normalizeUrl("https://example.com/p?a=1&b=2");
    expect(first.externalId).toBe(second.externalId);
    expect(first.externalId).toBe("/p?a=1&b=2");
  });

  it("drops a trailing slash", () => {
    expect(normalizeUrl("https://example.com/p/").externalId).toBe("/p");
  });

  it("keeps a non-default port in the origin and url but not the domain", () => {
    const result = normalizeUrl("https://example.com:8443/p");
    expect(result.domain).toBe("example.com");
    expect(result.origin).toBe("https://example.com:8443");
    expect(result.url).toBe("https://example.com:8443/p");
  });

  it("drops the default port", () => {
    expect(normalizeUrl("https://example.com:443/p").url).toBe("https://example.com/p");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => normalizeUrl("ftp://example.com/p")).toThrow(InvalidUrlError);
  });

  it("rejects a host without a dot", () => {
    expect(() => normalizeUrl("https://localhost/p")).toThrow(InvalidUrlError);
  });

  it("rejects an unparseable string", () => {
    expect(() => normalizeUrl("not a url")).toThrow(InvalidUrlError);
  });
});
