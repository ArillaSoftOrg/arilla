import { describe, expect, it } from "vitest";
import {
  CHAT_FEEDBACK_COMMENT_MAX,
  CHAT_FEEDBACK_MAX_WRITES,
  CHAT_FEEDBACK_REASONS,
  chatFeedbackRateLimitKey,
  consumeChatFeedbackQuota,
  validateChatFeedback,
} from "./feedback.ts";

describe("validateChatFeedback", () => {
  it("positive vote carries nothing", () => {
    expect(validateChatFeedback({ helpful: true })).toEqual({
      ok: true,
      reasons: [],
      comment: null,
    });
    expect(validateChatFeedback({ helpful: true, reasons: ["slow"] }).ok).toBe(false);
    expect(validateChatFeedback({ helpful: true, comment: "x" }).ok).toBe(false);
  });

  it("negative vote: reason and comment are optional", () => {
    expect(validateChatFeedback({ helpful: false })).toEqual({
      ok: true,
      reasons: [],
      comment: null,
    });
    expect(validateChatFeedback({ helpful: false, reasons: [], comment: "  " })).toEqual({
      ok: true,
      reasons: [],
      comment: null,
    });
  });

  it("accepts every allowed reason code and nothing else", () => {
    for (const code of CHAT_FEEDBACK_REASONS) {
      expect(validateChatFeedback({ helpful: false, reasons: [code] }).ok).toBe(true);
    }
    expect(validateChatFeedback({ helpful: false, reasons: ["bogus"] }).ok).toBe(false);
    expect(validateChatFeedback({ helpful: false, reasons: "slow" }).ok).toBe(false);
    expect(validateChatFeedback({ helpful: false, reasons: [1] }).ok).toBe(false);
  });

  it("dedupes reasons and caps them at three", () => {
    expect(validateChatFeedback({ helpful: false, reasons: ["slow", "slow"] })).toMatchObject({
      reasons: ["slow"],
    });
    expect(
      validateChatFeedback({
        helpful: false,
        reasons: ["slow", "other", "irrelevant", "not_found"],
      }).ok,
    ).toBe(false);
  });

  it("cleans the comment and enforces the length cap by code points", () => {
    expect(validateChatFeedback({ helpful: false, comment: " a\u0000b\r\nc " })).toMatchObject({
      comment: "ab\nc",
    });
    expect(
      validateChatFeedback({ helpful: false, comment: "x".repeat(CHAT_FEEDBACK_COMMENT_MAX) }).ok,
    ).toBe(true);
    expect(
      validateChatFeedback({
        helpful: false,
        comment: "x".repeat(CHAT_FEEDBACK_COMMENT_MAX + 1),
      }).ok,
    ).toBe(false);
    // Emoji tek kod noktasi: 500 emoji sinirda gecerli (UTF-16 uzunlugu 1000).
    expect(
      validateChatFeedback({ helpful: false, comment: "😀".repeat(CHAT_FEEDBACK_COMMENT_MAX) }).ok,
    ).toBe(true);
  });

  it("rejects non-boolean helpful and non-string comment", () => {
    expect(validateChatFeedback({ helpful: "yes" }).ok).toBe(false);
    expect(validateChatFeedback({ helpful: undefined }).ok).toBe(false);
    expect(validateChatFeedback({ helpful: false, comment: 5 }).ok).toBe(false);
  });
});

describe("consumeChatFeedbackQuota", () => {
  it("uses a per-user key and blocks after the cap", async () => {
    const seen: string[] = [];
    let count = 0;
    const increment = async (key: string) => {
      seen.push(key);
      count += 1;
      return count;
    };
    expect(chatFeedbackRateLimitKey(7)).toBe("chat_fb:user:7");
    for (let i = 0; i < CHAT_FEEDBACK_MAX_WRITES; i++) {
      expect(await consumeChatFeedbackQuota(7, increment)).toBe(true);
    }
    expect(await consumeChatFeedbackQuota(7, increment)).toBe(false);
    expect(new Set(seen)).toEqual(new Set(["chat_fb:user:7"]));
  });

  it("propagates a Redis failure (caller fails closed)", async () => {
    const boom = async () => {
      throw new Error("redis down");
    };
    await expect(consumeChatFeedbackQuota(7, boom)).rejects.toThrow("redis down");
  });
});
