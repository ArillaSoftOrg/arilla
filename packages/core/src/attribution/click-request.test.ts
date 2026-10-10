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
  it.each([
    // iOS Safari
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    // Android Chrome
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    // Android device whose name contains \"bot\"
    "Mozilla/5.0 (Linux; Android 12; Cubot X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    // Instagram in-app browser (Android)
    "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Instagram 330.0.0.40.99 Android",
    // Facebook in-app browser (iOS)
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 [FBAN/FBIOS;FBAV/470.0;FBBV/1;FBDV/iPhone15,2]",
    // TikTok in-app browser
    "Mozilla/5.0 (Linux; Android 13; SM-A546B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0 Mobile Safari/537.36 musical_ly_2023 BytedanceWebview/d8a21c6",
    // LINE in-app browser
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.0.0",
    // Samsung Internet, Firefox, Edge
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0",
  ])("treats real-user UA as human: %s", (ua) => {
    expect(classifyClickRequest(req({ "user-agent": ua }))).toBe("human");
    // Normal navigations may carry Sec-Purpose-less fetch metadata headers.
    expect(
      classifyClickRequest(
        req({ "user-agent": ua, "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" }),
      ),
    ).toBe("human");
  });
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
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Twitterbot/1.0",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
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
