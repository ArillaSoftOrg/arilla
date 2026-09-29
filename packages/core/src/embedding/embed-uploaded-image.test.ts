import { describe, expect, it, vi } from "vitest";
import { costMicrosPerThousandTokens } from "./embed-uploaded-image.ts";

describe("costMicrosPerThousandTokens", () => {
  it("uses a configured non-negative integer price", () => {
    expect(costMicrosPerThousandTokens({ EMBEDDING_COST_MICROS_PER_1K_TOKENS: "125" })).toBe(125);
    expect(costMicrosPerThousandTokens({ EMBEDDING_COST_MICROS_PER_1K_TOKENS: " 125 " })).toBe(125);
  });

  it("never returns NaN or a negative price (api_usage INSERT must not fail)", () => {
    for (const raw of [undefined, "", "0", "abc", "-5", "1.5"]) {
      const value = costMicrosPerThousandTokens({ EMBEDDING_COST_MICROS_PER_1K_TOKENS: raw });
      expect(value).toBe(0);
    }
  });

  it("warns at most once per process without breaking the call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    costMicrosPerThousandTokens({});
    costMicrosPerThousandTokens({ EMBEDDING_COST_MICROS_PER_1K_TOKENS: "abc" });
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });
});
