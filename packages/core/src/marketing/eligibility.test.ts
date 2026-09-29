import { describe, expect, it } from "vitest";
import { MARKETING_EMAIL_CONSENT_TEXT } from "./consent-text.ts";
import {
  decideMarketingEligibility,
  type MarketingConsentEvent,
  type MarketingFacts,
} from "./eligibility.ts";
import type { MarketingPolicy } from "./policy.ts";

const EMAIL = "Kisi@Example.test";

const live: Pick<MarketingPolicy, "mode" | "allowlist" | "requireExternalSync"> = {
  mode: "live",
  allowlist: new Set(),
  requireExternalSync: true,
};
const allowlist: typeof live = {
  mode: "allowlist",
  allowlist: new Set(["kisi@example.test"]),
  requireExternalSync: false,
};

const OPT_IN: MarketingConsentEvent = {
  id: 99,
  granted: true,
  grantedAt: new Date("2026-09-29T10:00:00Z"),
  source: "account_settings",
  textVersion: MARKETING_EMAIL_CONSENT_TEXT.version,
  email: "kisi@example.test",
};

function facts(overrides: Partial<MarketingFacts> = {}): MarketingFacts {
  return {
    user: { id: 7, email: EMAIL, emailVerified: true },
    latest: OPT_IN,
    suppressed: false,
    externalSyncStatus: "synced",
    ...overrides,
  };
}

describe("decideMarketingEligibility", () => {
  it("opted-in, verified, unsuppressed, synced user is eligible", () => {
    expect(decideMarketingEligibility(facts(), live)).toEqual({
      eligible: true,
      userId: 7,
      email: EMAIL,
      emailHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      consentId: 99,
    });
  });

  it("user without any consent event is not eligible", () => {
    expect(decideMarketingEligibility(facts({ latest: null }), allowlist)).toEqual({
      eligible: false,
      reason: "no_consent",
    });
  });

  it("latest event being an opt-out wins", () => {
    const latest = { ...OPT_IN, granted: false, textVersion: null };
    expect(decideMarketingEligibility(facts({ latest }), allowlist)).toMatchObject({
      reason: "opted_out",
    });
  });

  it("legacy (unversioned) consent is not demonstrable — existing users are not silently opted in", () => {
    const latest = { ...OPT_IN, source: null, textVersion: null, email: null };
    expect(decideMarketingEligibility(facts({ latest }), allowlist)).toMatchObject({
      reason: "unverifiable_consent",
    });
  });

  it("suppression blocks even with a valid consent", () => {
    expect(decideMarketingEligibility(facts({ suppressed: true }), allowlist)).toMatchObject({
      reason: "suppressed",
    });
  });

  it("consent given for another address does not carry over", () => {
    const latest = { ...OPT_IN, email: "eski@example.test" };
    expect(decideMarketingEligibility(facts({ latest }), allowlist)).toMatchObject({
      reason: "consent_email_mismatch",
    });
  });

  it("requires a present, well-formed, verified address", () => {
    expect(decideMarketingEligibility(facts({ user: null }), allowlist)).toMatchObject({
      reason: "no_user",
    });
    expect(
      decideMarketingEligibility(
        facts({ user: { id: 7, email: null, emailVerified: true } }),
        allowlist,
      ),
    ).toMatchObject({ reason: "no_email" });
    expect(
      decideMarketingEligibility(
        facts({ user: { id: 7, email: "a b@x", emailVerified: true } }),
        allowlist,
      ),
    ).toMatchObject({ reason: "invalid_email" });
    expect(
      decideMarketingEligibility(
        facts({ user: { id: 7, email: EMAIL, emailVerified: false } }),
        allowlist,
      ),
    ).toMatchObject({ reason: "email_unverified" });
  });

  it("off mode blocks everything", () => {
    expect(decideMarketingEligibility(facts(), { ...live, mode: "off" })).toEqual({
      eligible: false,
      reason: "disabled",
    });
  });

  it("allowlist mode only reaches listed addresses", () => {
    expect(
      decideMarketingEligibility(facts(), {
        ...allowlist,
        allowlist: new Set(["baska@example.test"]),
      }),
    ).toMatchObject({ reason: "not_allowlisted" });
  });

  it("live mode refuses consents not yet synced to IYS", () => {
    for (const externalSyncStatus of ["pending", "failed", null] as const) {
      expect(decideMarketingEligibility(facts({ externalSyncStatus }), live)).toMatchObject({
        reason: "external_sync_pending",
      });
    }
  });
});
