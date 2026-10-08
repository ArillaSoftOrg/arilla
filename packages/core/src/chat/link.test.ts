import { describe, expect, it } from "vitest";
import {
  type ChatLinkPayload,
  type ChatReferenceMessage,
  chatLinkFailureCopy,
  extractChatLink,
  parseChatLinkPayload,
  resolveChatReference,
} from "./link.ts";

const URL1 = "https://www.magaza.com/urun/siyah-sneaker-123?utm_source=x";

describe("extractChatLink", () => {
  it("returns found:false without a link", () => {
    expect(extractChatLink("siyah spor ayakkabı arıyorum")).toEqual({ found: false });
    expect(extractChatLink("")).toEqual({ found: false });
  });

  it("extracts a link that is the whole message", () => {
    const result = extractChatLink(URL1);
    expect(result).toMatchObject({
      found: true,
      ok: true,
      url: URL1,
      extraLinks: 0,
      remainder: "",
    });
    // tracking parameter is stripped by the canonical form
    expect(result.found && result.ok && result.normalizedUrl).not.toContain("utm_source");
  });

  it("keeps the description before and after the link as remainder", () => {
    const result = extractChatLink(`Bunun benzerini bul ${URL1} ama siyah olsun`);
    expect(result).toMatchObject({
      ok: true,
      remainder: "Bunun benzerini bul ama siyah olsun",
    });
  });

  it("finds a link in the middle of the sentence", () => {
    const result = extractChatLink("bak şuna https://magaza.com/u/1 5000 TL altı olsun");
    expect(result).toMatchObject({ ok: true, remainder: "bak şuna 5000 TL altı olsun" });
  });

  it("accepts www. links and adds https://", () => {
    const result = extractChatLink("www.magaza.com/urun/x daha uygun fiyatlı");
    expect(result).toMatchObject({
      ok: true,
      url: "https://www.magaza.com/urun/x",
      remainder: "daha uygun fiyatlı",
    });
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractChatLink("HTTPS://magaza.com/u/1")).toMatchObject({ ok: true });
  });

  it("trims trailing punctuation", () => {
    for (const text of [
      "bak https://magaza.com/u/1.",
      "bak https://magaza.com/u/1,",
      "bak https://magaza.com/u/1!",
      "bak https://magaza.com/u/1?",
      "(https://magaza.com/u/1)",
      "[bu](https://magaza.com/u/1)",
      "https://magaza.com/u/1);",
    ]) {
      const result = extractChatLink(text);
      expect(result, text).toMatchObject({ ok: true, url: "https://magaza.com/u/1" });
    }
  });

  it("keeps balanced parentheses that belong to the path", () => {
    const result = extractChatLink("https://magaza.com/urun_(mavi)");
    expect(result).toMatchObject({ ok: true, url: "https://magaza.com/urun_(mavi)" });
  });

  it("picks the first VALID link and counts the others", () => {
    const result = extractChatLink(
      "http://localhost/x https://a.com/1 https://b.com/2 siyah olsun",
    );
    expect(result).toMatchObject({
      ok: true,
      url: "https://a.com/1",
      extraLinks: 2,
      remainder: "siyah olsun",
    });
  });

  it("reports blocked destinations and invalid links with a reason", () => {
    expect(extractChatLink("https://localhost/x")).toMatchObject({
      found: true,
      ok: false,
      reason: "blocked",
    });
    expect(extractChatLink("http://192.168.1.5/x bak")).toMatchObject({
      ok: false,
      reason: "blocked",
      remainder: "bak",
    });
    expect(extractChatLink("https://user:pw@magaza.com/x")).toMatchObject({
      ok: false,
      reason: "blocked",
    });
  });

  it("does not treat bare words or other schemes as links", () => {
    expect(extractChatLink("ftp://magaza.com/x")).toEqual({ found: false });
    expect(extractChatLink("javascript:alert(1)")).toEqual({ found: false });
    expect(extractChatLink("mail@www.magaza.com")).toEqual({ found: false });
  });
});

const LINK: ChatLinkPayload = {
  version: 1,
  requestId: "11111111-2222-4333-8444-555555555555",
  normalizedUrl: "https://magaza.com/u/1",
  remainderText: "siyah",
  preferences: { colors: ["siyah"], priceMaxKurus: 300000, sort: "cheapest" },
  extraLinks: 1,
  errorCode: null,
  note: null,
};

describe("parseChatLinkPayload", () => {
  it("round-trips a valid payload", () => {
    expect(parseChatLinkPayload(JSON.parse(JSON.stringify(LINK)))).toEqual(LINK);
  });

  it("rejects wrong version, non-objects and records without request or error", () => {
    expect(parseChatLinkPayload(null)).toBeNull();
    expect(parseChatLinkPayload("x")).toBeNull();
    expect(parseChatLinkPayload({ ...LINK, version: 2 })).toBeNull();
    expect(parseChatLinkPayload({ ...LINK, requestId: "nope" })).toBeNull();
  });

  it("keeps an error-only payload and sanitizes preferences", () => {
    const parsed = parseChatLinkPayload({
      ...LINK,
      requestId: null,
      errorCode: "no_rights",
      preferences: { priceMaxKurus: -5, colors: ["a", 3, "b"], sort: "evil", x: 1 },
      extraLinks: -3,
    });
    expect(parsed).toMatchObject({
      requestId: null,
      errorCode: "no_rights",
      preferences: { colors: ["a", "b"] },
      extraLinks: 0,
    });
    expect(parsed?.preferences.priceMaxKurus).toBeUndefined();
  });

  it("drops non-code error strings", () => {
    expect(parseChatLinkPayload({ ...LINK, requestId: null, errorCode: "Free <text>" })).toBeNull();
  });
});

function msg(
  role: "user" | "assistant",
  kind: string,
  extra: Partial<ChatReferenceMessage> = {},
): ChatReferenceMessage {
  return { role, kind, ...extra };
}

describe("resolveChatReference", () => {
  it("is null for a plain conversation", () => {
    expect(resolveChatReference([msg("user", "text"), msg("assistant", "search")])).toBeNull();
    expect(resolveChatReference([])).toBeNull();
  });

  it("finds the latest link notice", () => {
    const ref = resolveChatReference([
      msg("user", "text"),
      msg("assistant", "notice", { link: LINK }),
      msg("user", "text"),
    ]);
    expect(ref).toMatchObject({ type: "link", index: 1 });
  });

  it("an image message is a reference too", () => {
    expect(
      resolveChatReference([msg("user", "text", { attachmentId: "a" }), msg("user", "text")]),
    ).toMatchObject({ type: "image", index: 0 });
  });

  it("the newer of link and image wins", () => {
    const later = resolveChatReference([
      msg("user", "text", { attachmentId: "a" }),
      msg("assistant", "notice", { link: LINK }),
      msg("user", "text"),
    ]);
    expect(later?.type).toBe("link");
    const imageLater = resolveChatReference([
      msg("assistant", "notice", { link: LINK }),
      msg("user", "text", { attachmentId: "a" }),
      msg("user", "text"),
    ]);
    expect(imageLater?.type).toBe("image");
  });

  it("a normal search or clarify answer after the reference drops it", () => {
    expect(
      resolveChatReference([
        msg("assistant", "notice", { link: LINK }),
        msg("user", "text"),
        msg("assistant", "search"),
        msg("user", "text"),
      ]),
    ).toBeNull();
    expect(
      resolveChatReference([
        msg("user", "text", { attachmentId: "a" }),
        msg("assistant", "search"),
        msg("user", "text"),
      ]),
    ).toBeNull();
  });

  it("a link that failed before being queued is not a reference", () => {
    expect(
      resolveChatReference([
        msg("assistant", "notice", { link: { ...LINK, requestId: null, errorCode: "no_rights" } }),
        msg("user", "text"),
      ]),
    ).toBeNull();
  });
});

describe("chatLinkFailureCopy", () => {
  const CODES = [
    "robots_disallowed",
    "access_denied",
    "not_found",
    "no_product",
    "unsupported_content",
    "too_large",
    "blocked_destination",
    "invalid_url",
    "too_many_redirects",
    "rate_limited",
    "upstream_error",
    "timeout",
    "fetch_failed",
    "queue_unavailable",
    "unexpected",
    "no_rights",
    "search_rate_limited",
    "busy",
    "retry",
    "stale",
    "text_only",
    "empty",
    "preference_not_understood",
    "something_new",
  ];

  it("gives every code a Turkish title and description", () => {
    for (const code of CODES) {
      const copy = chatLinkFailureCopy(code, { imageEnabled: true });
      expect(copy.title.length, code).toBeGreaterThan(5);
      expect(copy.description.length, code).toBeGreaterThan(5);
    }
  });

  it("never uses forbidden words or ALL CAPS words", () => {
    for (const code of CODES) {
      for (const imageEnabled of [true, false]) {
        const copy = chatLinkFailureCopy(code, { imageEnabled });
        const text = `${copy.title} ${copy.description}`;
        expect(text.toLocaleLowerCase("tr-TR"), code).not.toMatch(/satın al|dupe|ucuz/);
        expect(text, code).not.toMatch(/\b[A-ZÇĞİÖŞÜ]{4,}\b/);
      }
    }
  });

  it("suggests a photo only when images are enabled", () => {
    expect(chatLinkFailureCopy("not_found", { imageEnabled: true }).description).toContain(
      "fotoğrafını",
    );
    expect(chatLinkFailureCopy("not_found", { imageEnabled: false }).description).not.toContain(
      "fotoğraf",
    );
    expect(chatLinkFailureCopy("not_found").description).toContain("tarif");
  });

  it("unknown codes fall back to the generic copy", () => {
    expect(chatLinkFailureCopy("zzz")).toEqual(chatLinkFailureCopy("another"));
  });
});
