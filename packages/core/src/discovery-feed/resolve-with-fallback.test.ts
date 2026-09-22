import { describe, expect, it } from "vitest";
import { resolveWithFallback } from "./resolve-with-fallback.ts";

describe("resolveWithFallback", () => {
  it("gercek veri varsa fallback acik olsa bile gercek veriyi dondurur", () => {
    const result = resolveWithFallback(["real-1", "real-2"], ["demo-1"], true);
    expect(result).toEqual(["real-1", "real-2"]);
  });

  it("gercek veri bos VE fallback acikken fallback'e duser", () => {
    const result = resolveWithFallback([], ["demo-1", "demo-2"], true);
    expect(result).toEqual(["demo-1", "demo-2"]);
  });

  it("gercek veri bos VE fallback kapaliyken bos dizi doner", () => {
    const result = resolveWithFallback([], ["demo-1"], false);
    expect(result).toEqual([]);
  });

  it("gercek veri de fallback da bosken bos dizi doner", () => {
    const result = resolveWithFallback([], [], true);
    expect(result).toEqual([]);
  });
});
