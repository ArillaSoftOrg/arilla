import { describe, expect, it, vi } from "vitest";
import { emailHash } from "./email-hash.ts";
import { sendMarketingEmail } from "./send-marketing-email.ts";
import {
  generateUnsubscribeToken,
  hashUnsubscribeToken,
  isUnsubscribeTokenShape,
  unsubscribeByToken,
  unsubscribeUrls,
} from "./unsubscribe.ts";

describe("unsubscribe token", () => {
  it("is 256-bit url-safe and stored only as a sha-256 hex digest", () => {
    const token = generateUnsubscribeToken();
    expect(isUnsubscribeTokenShape(token.raw)).toBe(true);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).toBe(hashUnsubscribeToken(token.raw));
    expect(token.hash).not.toContain(token.raw);
    expect(generateUnsubscribeToken().raw).not.toBe(token.raw);
  });

  it("rejects malformed tokens before touching the database", async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("db touched");
        },
      },
    ) as never;
    for (const raw of [undefined, null, "", "short", "x".repeat(44), "a/b".padEnd(43, "a"), 42]) {
      await expect(unsubscribeByToken(db, raw, { ip: null })).resolves.toEqual({
        status: "invalid",
      });
    }
  });

  it("builds page and one-click URLs on the app origin", () => {
    const { raw } = generateUnsubscribeToken();
    expect(unsubscribeUrls("https://example.test", raw)).toEqual({
      page: `https://example.test/abonelik-iptali?t=${raw}`,
      oneClick: `https://example.test/api/email/unsubscribe?t=${raw}`,
    });
  });
});

describe("email hash", () => {
  it("normalizes case and whitespace without Turkish locale casing", () => {
    expect(emailHash("  Kisi@Example.TEST ")).toBe(emailHash("kisi@example.test"));
    expect(emailHash("I@example.test")).toBe(emailHash("i@example.test"));
  });
});

describe("sendMarketingEmail in off mode", () => {
  it("returns disabled without touching the database or transport", async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("db touched");
        },
      },
    ) as never;
    const sendMail = vi.fn();
    const result = await sendMarketingEmail(
      db,
      { userId: 1, campaignKey: "launch", content: { subject: "s", text: "t", html: "h" } },
      {
        policy: {
          mode: "off",
          from: null,
          replyTo: null,
          allowlist: new Set(),
          requireExternalSync: true,
        },
        transport: { sendMail },
      },
    );
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
