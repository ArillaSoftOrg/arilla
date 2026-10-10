import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";
});

describe("generateRawToken", () => {
  it("returns url-safe, sufficiently long random tokens that differ each call", async () => {
    const { generateRawToken } = await import("./token.ts");
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).not.toMatch(/[+/=]/);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same input", async () => {
    const { hashToken } = await import("./token.ts");
    expect(hashToken("same-raw-token")).toBe(hashToken("same-raw-token"));
  });

  it("produces different hashes for different tokens", async () => {
    const { hashToken } = await import("./token.ts");
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  it("never returns the raw token as a substring of the hash", async () => {
    const { hashToken } = await import("./token.ts");
    const raw = "super-secret-raw-value";
    expect(hashToken(raw)).not.toContain(raw);
  });

  it("throws when SESSION_SECRET is missing", async () => {
    const original = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    const { hashToken } = await import("./token.ts");
    expect(() => hashToken("x")).toThrow();
    process.env.SESSION_SECRET = original;
  });
});

describe("pseudonymize", () => {
  it("is deterministic and a 64-char hex HMAC, never the plain value", async () => {
    const { pseudonymize } = await import("./token.ts");
    const a = pseudonymize("feedback", "203.0.113.9");
    expect(a).toBe(pseudonymize("feedback", "203.0.113.9"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.9");
  });

  it("is not the unsalted SHA-256 an attacker could precompute for the IPv4 space", async () => {
    const { createHash } = await import("node:crypto");
    const { pseudonymize } = await import("./token.ts");
    const plain = createHash("sha256").update("203.0.113.9").digest("hex");
    expect(pseudonymize("feedback", "203.0.113.9")).not.toBe(plain);
  });

  it("separates purposes: the same IP yields different digests per feature", async () => {
    const { pseudonymize } = await import("./token.ts");
    expect(pseudonymize("feedback", "203.0.113.9")).not.toBe(pseudonymize("forms", "203.0.113.9"));
  });

  it("depends on the secret", async () => {
    const { pseudonymize } = await import("./token.ts");
    const before = pseudonymize("auth", "a@b.test");
    const original = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "baska-bir-test-sirri";
    try {
      expect(pseudonymize("auth", "a@b.test")).not.toBe(before);
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });

  it("does not collide with token hashes of the same text", async () => {
    const { hashToken, pseudonymize } = await import("./token.ts");
    expect(pseudonymize("auth", "x")).not.toBe(hashToken("x"));
  });

  it("fails closed with SecretNotConfiguredError when the secret is missing", async () => {
    const { pseudonymize, SecretNotConfiguredError } = await import("./token.ts");
    const original = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      expect(() => pseudonymize("forms", "203.0.113.9")).toThrow(SecretNotConfiguredError);
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });
});
