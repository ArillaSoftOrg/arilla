import { afterEach, describe, expect, it, vi } from "vitest";
import { costMicrosPerThousandTokens } from "./embed-uploaded-image.ts";

const env = (value: string | undefined) => ({ EMBEDDING_COST_MICROS_PER_1K_TOKENS: value });

describe("costMicrosPerThousandTokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tanimsiz ya da bos oran 0 (uyari yok)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(costMicrosPerThousandTokens({})).toBe(0);
    expect(costMicrosPerThousandTokens(env(""))).toBe(0);
    expect(costMicrosPerThousandTokens(env("   "))).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("negatif olmayan duz tamsayi aynen kullanilir (kenar bosluklari kirpilir)", () => {
    expect(costMicrosPerThousandTokens(env("0"))).toBe(0);
    expect(costMicrosPerThousandTokens(env("250"))).toBe(250);
    expect(costMicrosPerThousandTokens(env(" 1200 "))).toBe(1200);
  });

  it("gecersiz oran NaN uretmez: 0 doner, uyari en fazla bir kez ve degersiz", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of [
      "abc",
      "-5",
      "1.5",
      "1e3",
      "0x10",
      "Infinity",
      "12abc",
      "99999999999999999999",
    ]) {
      const value = costMicrosPerThousandTokens(env(raw));
      expect(value).toBe(0);
      expect(Number.isNaN(value)).toBe(false);
    }
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of warn.mock.calls) {
      expect(call.join(" ")).not.toContain("abc");
    }
  });
});
