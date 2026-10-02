import { describe, expect, it } from "vitest";
import { MarketingConfigError, marketingEmailConfigFromEnv } from "./config.ts";

const LOCAL = { SMTP_HOST: "localhost", SMTP_PORT: "1025", EMAIL_FROM: "Bildirim <n@test.local>" };
const REMOTE = {
  SMTP_HOST: "smtp.resend.com",
  SMTP_PORT: "465",
  SMTP_USER: "resend",
  SMTP_PASS: "gizli-deger-123",
  EMAIL_FROM: "Bildirim <n@manicepte.test>",
};

describe("marketingEmailConfigFromEnv", () => {
  it("allows bulk sending to the local Mailpit relay and falls back to EMAIL_FROM", () => {
    const config = marketingEmailConfigFromEnv(LOCAL);
    expect(config.bulkSendAllowed).toBe(true);
    expect(config.from).toBe(LOCAL.EMAIL_FROM);
    expect(config.batchSize).toBe(40);
    expect(config.maxAttempts).toBe(3);
  });

  it("blocks bulk sending with a real SMTP host outside Vercel production", () => {
    for (const VERCEL_ENV of [undefined, "preview", "development"]) {
      const config = marketingEmailConfigFromEnv({ ...REMOTE, VERCEL_ENV, NODE_ENV: "production" });
      expect(config.bulkSendAllowed).toBe(false);
      expect(config.bulkSendBlock).toBe("non_production_remote_smtp");
    }
  });

  it("requires the explicit switch and a marketing sender in production", () => {
    const prod = { ...REMOTE, VERCEL_ENV: "production", NODE_ENV: "production" };
    expect(() => marketingEmailConfigFromEnv(prod)).toThrow(MarketingConfigError);
    const withFrom = { ...prod, MARKETING_EMAIL_FROM: "ManiCepte <haber@manicepte.test>" };
    expect(marketingEmailConfigFromEnv(withFrom).bulkSendBlock).toBe("disabled_in_production");
    const enabled = marketingEmailConfigFromEnv({ ...withFrom, MARKETING_EMAIL_ENABLED: "true" });
    expect(enabled.bulkSendAllowed).toBe(true);
    expect(enabled.from).toBe("ManiCepte <haber@manicepte.test>");
  });

  it("validates numeric limits without echoing values", () => {
    expect(() =>
      marketingEmailConfigFromEnv({ ...LOCAL, MARKETING_EMAIL_BATCH_SIZE: "abc" }),
    ).toThrow(/MARKETING_EMAIL_BATCH_SIZE/);
    expect(() =>
      marketingEmailConfigFromEnv({ ...LOCAL, MARKETING_EMAIL_MAX_ATTEMPTS: "9" }),
    ).toThrow(MarketingConfigError);
    expect(
      marketingEmailConfigFromEnv({ ...LOCAL, MARKETING_EMAIL_BATCH_SIZE: "5" }).batchSize,
    ).toBe(5);
  });

  it("wraps SMTP misconfiguration and never includes secret values in messages", () => {
    try {
      marketingEmailConfigFromEnv({ ...REMOTE, SMTP_USER: undefined });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MarketingConfigError);
      expect((error as Error).message).not.toContain(REMOTE.SMTP_PASS);
    }
  });

  it("rejects a malformed reply-to", () => {
    expect(() =>
      marketingEmailConfigFromEnv({ ...LOCAL, MARKETING_EMAIL_REPLY_TO: "yok" }),
    ).toThrow(MarketingConfigError);
  });
});
