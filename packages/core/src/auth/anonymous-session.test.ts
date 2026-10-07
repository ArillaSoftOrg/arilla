import { beforeEach, describe, expect, it, vi } from "vitest";

const increment = vi.fn(async (_key: string, _window: number) => 1);
vi.mock("../redis/counter.ts", () => ({
  incrementFixedWindow: (key: string, window: number) => increment(key, window),
}));

const { anonymousSessionCookieOptions, newAnonymousSessionId, validAnonymousSessionId } =
  await import("./anonymous-session.ts");
const { recordSearchAndCheckWall } = await import("./search-wall.ts");

const VALID = "3f2b8c1e-9a4d-4e7f-8b21-6c0d5e9f1a23";

describe("validAnonymousSessionId", () => {
  it("kanonik küçük harfli UUID'yi kabul eder", () => {
    expect(validAnonymousSessionId(VALID)).toBe(VALID);
    expect(validAnonymousSessionId(newAnonymousSessionId())).not.toBeNull();
  });

  it.each([
    undefined,
    null,
    "",
    "abc",
    VALID.toUpperCase(),
    `${VALID} `,
    `${VALID}x`,
    `{${VALID}}`,
    "a".repeat(4000),
    "search-wall:*",
  ])("geçersiz değeri reddeder: %s", (value) => {
    expect(validAnonymousSessionId(value as string | null | undefined)).toBeNull();
  });
});

describe("anonymousSessionCookieOptions", () => {
  it("httpOnly; production'da secure, yerelde değil", () => {
    expect(anonymousSessionCookieOptions({ NODE_ENV: "production" })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    expect(anonymousSessionCookieOptions({ NODE_ENV: "development" }).secure).toBe(false);
  });
});

describe("recordSearchAndCheckWall", () => {
  beforeEach(() => increment.mockClear());

  it("geçersiz session_id Redis anahtarı üretmez", async () => {
    for (const value of ["a".repeat(4000), "x", `${VALID}:extra`, VALID.toUpperCase()]) {
      expect(await recordSearchAndCheckWall(value)).toEqual({ shouldShowWall: false });
    }
    expect(increment).not.toHaveBeenCalled();
  });

  it("geçerli session_id sabit biçimli anahtarla sayılır", async () => {
    await recordSearchAndCheckWall(VALID);
    expect(increment).toHaveBeenCalledWith(`search-wall:${VALID}`, 60 * 60 * 24);
  });
});
