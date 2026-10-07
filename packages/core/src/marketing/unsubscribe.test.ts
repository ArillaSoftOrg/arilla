import { describe, expect, it } from "vitest";
import {
  generateUnsubscribeToken,
  hashUnsubscribeToken,
  isUnsubscribeTokenShape,
  unsubscribeUrls,
} from "./unsubscribe.ts";

describe("unsubscribe token", () => {
  it("is random, url-safe and stored only as a sha-256 hex digest", () => {
    const a = generateUnsubscribeToken();
    const b = generateUnsubscribeToken();
    expect(a.raw).not.toBe(b.raw);
    expect(isUnsubscribeTokenShape(a.raw)).toBe(true);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashUnsubscribeToken(a.raw));
    expect(a.hash).not.toContain(a.raw);
  });

  it("rejects malformed input before any lookup", () => {
    for (const value of [undefined, null, 42, "", "kisa", `${"a".repeat(43)}!`, "a".repeat(44)]) {
      expect(isUnsubscribeTokenShape(value)).toBe(false);
    }
  });

  it("builds page and one-click URLs without any account identifier", () => {
    const { raw } = generateUnsubscribeToken();
    const urls = unsubscribeUrls("https://manicepte.test", raw);
    expect(urls.page).toBe(`https://manicepte.test/abonelik-iptali?t=${raw}`);
    expect(urls.oneClick).toBe(`https://manicepte.test/api/email/unsubscribe?t=${raw}`);
  });
});
