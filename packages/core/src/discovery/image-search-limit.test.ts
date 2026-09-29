import { describe, expect, it } from "vitest";
import {
  imageSearchIpLimitKey,
  imageSearchLimitKey,
  recordImageSearchAndCheckLimit,
} from "./image-search-limit.ts";

function memoryCounter() {
  const counts = new Map<string, number>();
  const increment = async (key: string) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
  return { counts, increment };
}

const ENV = { VISUAL_SEARCH_DAILY_LIMIT_PER_USER: "2", VISUAL_SEARCH_DAILY_LIMIT_PER_IP: "3" };

describe("recordImageSearchAndCheckLimit", () => {
  it("caps anonymous requests per IP even when the session cookie is rotated", async () => {
    const { increment } = memoryCounter();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const { allowed } = await recordImageSearchAndCheckLimit(
        { userId: null, sessionId: `session-${i}`, ip: "203.0.113.7" },
        increment,
        ENV,
      );
      results.push(allowed);
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("keeps the per-session limit for anonymous users", async () => {
    const { increment } = memoryCounter();
    const results: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const { allowed } = await recordImageSearchAndCheckLimit(
        { userId: null, sessionId: "same", ip: "203.0.113.7" },
        increment,
        ENV,
      );
      results.push(allowed);
    }
    expect(results).toEqual([true, true, false]);
  });

  it("does not count session-rejected requests against the IP cap", async () => {
    const { counts, increment } = memoryCounter();
    for (let i = 0; i < 4; i++) {
      await recordImageSearchAndCheckLimit(
        { userId: null, sessionId: "same", ip: "203.0.113.7" },
        increment,
        ENV,
      );
    }
    expect(counts.get(imageSearchIpLimitKey("203.0.113.7"))).toBe(2);
  });

  it("does not apply the IP cap to signed-in users", async () => {
    const { counts, increment } = memoryCounter();
    const { allowed } = await recordImageSearchAndCheckLimit(
      { userId: 42, sessionId: "s", ip: "203.0.113.7" },
      increment,
      ENV,
    );
    expect(allowed).toBe(true);
    expect([...counts.keys()]).toEqual([imageSearchLimitKey({ userId: 42, sessionId: "s" })]);
  });

  it("falls back to the session limit when the IP cannot be resolved", async () => {
    const { counts, increment } = memoryCounter();
    await recordImageSearchAndCheckLimit(
      { userId: null, sessionId: "s", ip: null },
      increment,
      ENV,
    );
    expect(counts.size).toBe(1);
  });

  it("never writes the raw IP into the Redis key", () => {
    expect(imageSearchIpLimitKey("203.0.113.7")).not.toContain("203.0.113.7");
    expect(imageSearchIpLimitKey(" 203.0.113.7 ")).toBe(imageSearchIpLimitKey("203.0.113.7"));
  });

  it("propagates counter failures (caller fails closed)", async () => {
    const failing = async () => {
      throw new Error("redis down");
    };
    await expect(
      recordImageSearchAndCheckLimit(
        { userId: null, sessionId: "s", ip: "203.0.113.7" },
        failing,
        ENV,
      ),
    ).rejects.toThrow("redis down");
  });
});
