import { describe, expect, it } from "vitest";
import { MarketingConfigError, marketingPolicyFromEnv } from "./policy.ts";

const FROM = "ManiCepte <haber@example.test>";

describe("marketingPolicyFromEnv", () => {
  it("defaults to off when nothing is configured", () => {
    const policy = marketingPolicyFromEnv({});
    expect(policy.mode).toBe("off");
  });

  it("rejects an unknown mode instead of guessing", () => {
    expect(() => marketingPolicyFromEnv({ MARKETING_EMAIL_MODE: "on" })).toThrow(
      MarketingConfigError,
    );
  });

  it("development cannot enable live marketing sends", () => {
    for (const env of [
      { NODE_ENV: "development" },
      { NODE_ENV: "test" },
      { NODE_ENV: "production" }, // `next start` locally, not on Vercel
      { NODE_ENV: "production", VERCEL_ENV: "preview" },
      { NODE_ENV: "production", VERCEL_ENV: "development" },
    ]) {
      expect(() =>
        marketingPolicyFromEnv(
          { ...env, MARKETING_EMAIL_MODE: "live", MARKETING_EMAIL_FROM: FROM },
          { legalIdentityComplete: true },
        ),
      ).toThrow(/Vercel production/);
    }
  });

  it("live requires a complete legal identity (sender identification)", () => {
    expect(() =>
      marketingPolicyFromEnv(
        {
          NODE_ENV: "production",
          VERCEL_ENV: "production",
          MARKETING_EMAIL_MODE: "live",
          MARKETING_EMAIL_FROM: FROM,
        },
        { legalIdentityComplete: false },
      ),
    ).toThrow(/yasal kimlik/);
  });

  it("live in Vercel production always requires external (IYS) sync", () => {
    const policy = marketingPolicyFromEnv(
      {
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        MARKETING_EMAIL_MODE: "live",
        MARKETING_EMAIL_FROM: FROM,
      },
      { legalIdentityComplete: true },
    );
    expect(policy).toMatchObject({ mode: "live", from: FROM, requireExternalSync: true });
  });

  it("any sending mode requires a dedicated marketing sender", () => {
    expect(() =>
      marketingPolicyFromEnv({
        MARKETING_EMAIL_MODE: "allowlist",
        MARKETING_EMAIL_ALLOWLIST: "a@example.test",
      }),
    ).toThrow(/MARKETING_EMAIL_FROM/);
  });

  it("allowlist mode requires a non-empty, valid list and normalizes it", () => {
    expect(() =>
      marketingPolicyFromEnv({ MARKETING_EMAIL_MODE: "allowlist", MARKETING_EMAIL_FROM: FROM }),
    ).toThrow(/ALLOWLIST/);
    expect(() =>
      marketingPolicyFromEnv({
        MARKETING_EMAIL_MODE: "allowlist",
        MARKETING_EMAIL_FROM: FROM,
        MARKETING_EMAIL_ALLOWLIST: "not-an-email",
      }),
    ).toThrow(/ALLOWLIST/);
    const policy = marketingPolicyFromEnv({
      MARKETING_EMAIL_MODE: "allowlist",
      MARKETING_EMAIL_FROM: FROM,
      MARKETING_EMAIL_ALLOWLIST: " Team@Example.test , b@example.test",
    });
    expect([...policy.allowlist]).toEqual(["team@example.test", "b@example.test"]);
    expect(policy.requireExternalSync).toBe(false);
  });

  it("never echoes configured values in errors", () => {
    try {
      marketingPolicyFromEnv({
        MARKETING_EMAIL_MODE: "allowlist",
        MARKETING_EMAIL_FROM: FROM,
        MARKETING_EMAIL_ALLOWLIST: "secret-person@",
      });
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-person");
    }
  });
});
