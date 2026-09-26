import { describe, expect, it } from "vitest";
import {
  checkLinkSearchUrl,
  isLinkSearchInput,
  LINK_SEARCH_PATH,
  linkSearchHref,
  urlFromPrefixSegments,
} from "./link-search-input.ts";

const PRODUCT = "https://www.magaza.example/products/siyah-deri-canta?variant=12&utm_source=ig";

/** Önek kısayolunun Next'e ulaştığı biçimi taklit eder: yol parçaları + sorgu. */
function prefixSegments(browserPath: string): { segments: string[]; search: string } {
  const [path = "", search = ""] = browserPath.split("?");
  // Next tekrar eden bölüleri tekilleştirir: "/https://x" -> "/https:/x".
  const collapsed = path.replace(/\/{2,}/g, "/");
  return {
    segments: collapsed.split("/").slice(1).map(decodeURIComponent),
    search: search ? `?${search}` : "",
  };
}

describe("isLinkSearchInput", () => {
  it.each([
    "https://magaza.example/urun",
    "http://magaza.example/urun",
    "  HTTPS://magaza.example/urun  ",
  ])("recognizes %s as a link", (value) => {
    expect(isLinkSearchInput(value)).toBe(true);
  });

  it.each([
    "siyah deri çanta",
    "https://",
    "magaza.example/urun",
    "ftp://magaza.example/urun",
    "javascript:alert(1)",
    "",
  ])("does not treat %j as a link", (value) => {
    expect(isLinkSearchInput(value)).toBe(false);
  });
});

describe("paste and prefix shortcut converge", () => {
  it("builds the same canonical request from both entry points", () => {
    const pasted = checkLinkSearchUrl(PRODUCT);

    const { segments, search } = prefixSegments(`/${PRODUCT}`);
    const rebuilt = urlFromPrefixSegments(segments, search);
    expect(rebuilt).not.toBeNull();
    const prefixed = checkLinkSearchUrl(rebuilt ?? "");

    expect(pasted.ok && prefixed.ok).toBe(true);
    if (pasted.ok && prefixed.ok) {
      expect(prefixed.normalized).toEqual(pasted.normalized);
      expect(pasted.normalized.url).toBe(
        "https://www.magaza.example/products/siyah-deri-canta?variant=12",
      );
    }
  });

  it("handles the un-collapsed segment shape too", () => {
    expect(urlFromPrefixSegments(["https:", "", "magaza.example", "p", "x"], "")).toBe(
      "https://magaza.example/p/x",
    );
  });

  it("accepts the whole link as one encoded segment (home search composer)", () => {
    const segments = `/${encodeURIComponent(PRODUCT)}`.split("/").slice(1).map(decodeURIComponent);
    const rebuilt = urlFromPrefixSegments(segments, "");
    expect(rebuilt).toBe(PRODUCT);
    const a = checkLinkSearchUrl(rebuilt ?? "");
    const b = checkLinkSearchUrl(PRODUCT);
    expect(a.ok && b.ok && a.normalized.url === b.normalized.url).toBe(true);
  });

  it("returns null for ordinary paths", () => {
    expect(urlFromPrefixSegments(["hakkinda"], "")).toBeNull();
    expect(urlFromPrefixSegments(["https:"], "")).toBeNull();
  });

  it("encodes the canonical href losslessly", () => {
    const url = "https://magaza.example/p?a=1&b=2";
    const href = linkSearchHref(url);
    expect(href.startsWith(`${LINK_SEARCH_PATH}?url=`)).toBe(true);
    expect(new URL(href, "https://arilla.test").searchParams.get("url")).toBe(url);
  });
});

describe("checkLinkSearchUrl", () => {
  it("drops tracking params and fragments", () => {
    const result = checkLinkSearchUrl(
      "https://magaza.example/urun/canta?fbclid=x&utm_medium=y#yorum",
    );
    expect(result.ok && result.normalized.url).toBe("https://magaza.example/urun/canta");
  });

  it.each([
    "http://localhost/urun",
    "http://api.localhost/urun",
    "http://127.0.0.1/urun",
    "http://2130706433/urun", // WHATWG -> 127.0.0.1
    "http://0x7f.1/urun",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://metadata.google.internal/",
    "http://nas.local/",
    "https://user:pw@magaza.example/urun",
    "https://magaza.example:6379/",
  ])("blocks %s", (value) => {
    expect(checkLinkSearchUrl(value)).toEqual({ ok: false, reason: "blocked" });
  });

  it.each([
    "file:///etc/passwd",
    "ftp://magaza.example/x",
    "data:text/html,x",
    "javascript:alert(1)",
    "https://intranet/",
    "düz metin",
    `https://magaza.example/${"a".repeat(3000)}`,
  ])("rejects %s as invalid", (value) => {
    const result = checkLinkSearchUrl(value);
    expect(result.ok).toBe(false);
  });
});
