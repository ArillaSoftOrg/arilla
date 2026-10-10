import { describe, expect, it } from "vitest";
import { classifyClickRequest, parseResultPosition } from "./click-request.ts";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const req = (headers: Record<string, string | undefined>, method = "GET") => ({
  method,
  headers: new Headers(
    Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined),
  ),
});

describe("classifyClickRequest", () => {
  it("treats a normal browser GET as human", () => {
    expect(classifyClickRequest(req({ "user-agent": CHROME }))).toBe("human");
  });
  it("flags HEAD", () => {
    expect(classifyClickRequest(req({ "user-agent": CHROME }, "HEAD"))).toBe("head");
  });
  it.each([
    { "sec-purpose": "prefetch" },
    { "sec-purpose": "prefetch;anonymous-client-ip" },
    { purpose: "prefetch" },
    { "x-moz": "prefetch" },
  ])("flags prefetch %o", (extra) => {
    expect(classifyClickRequest(req({ "user-agent": CHROME, ...extra }))).toBe("prefetch");
  });
  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "facebookexternalhit/1.1",
    "curl/8.4.0",
    "python-requests/2.31",
  ])("flags bot UA %s", (ua) => {
    expect(classifyClickRequest(req({ "user-agent": ua }))).toBe("bot");
  });
  it("flags a missing user agent", () => {
    expect(classifyClickRequest(req({}))).toBe("bot");
  });
});

describe("parseResultPosition", () => {
  it("accepts 1-based integers on list surfaces", () => {
    expect(parseResultPosition("1", "search")).toBe(1);
    expect(parseResultPosition("500", "compare")).toBe(500);
  });
  it.each(["0", "-1", "1.5", "abc", "501", "01", "99999", "1e2", ""])("rejects %j", (raw) => {
    expect(parseResultPosition(raw, "search")).toBeNull();
  });
  it("ignores position on non-list or missing surfaces", () => {
    expect(parseResultPosition("3", "product_primary")).toBeNull();
    expect(parseResultPosition("3", null)).toBeNull();
    expect(parseResultPosition(null, "search")).toBeNull();
  });
});
