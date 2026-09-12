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
