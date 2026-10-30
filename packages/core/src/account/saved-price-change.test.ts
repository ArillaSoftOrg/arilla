import { describe, expect, it } from "vitest";
import { classifyPriceChange } from "./saved-price-change.ts";

describe("classifyPriceChange", () => {
  it("düşüş, artış ve değişmeme; fark mutlak kuruş", () => {
    expect(classifyPriceChange(1000_00, 750_00)).toEqual({
      kind: "down",
      savedPriceKurus: 1000_00,
      currentPriceKurus: 750_00,
      diffKurus: 250_00,
      percent: 25,
    });
    expect(classifyPriceChange(1000_00, 1200_00)).toMatchObject({ kind: "up", diffKurus: 200_00 });
    expect(classifyPriceChange(999_99, 999_99)).toMatchObject({
      kind: "same",
      diffKurus: 0,
      percent: 0,
    });
  });

  it("yüzde tam sayı aritmetiğiyle yarım yukarı yuvarlanır", () => {
    const percent = (saved: number, current: number) => {
      const change = classifyPriceChange(saved, current);
      return change.kind === "insufficient" ? null : change.percent;
    };
    expect(percent(300, 299)).toBe(0); // %0,33
    expect(percent(200, 199)).toBe(1); // %0,5 -> 1
    expect(percent(300, 295)).toBe(2); // %1,67
    expect(percent(3, 2)).toBe(33); // %33,3
    expect(percent(100, 300)).toBe(200);
  });

  it("büyük tutarlarda hassasiyet kaybolmaz", () => {
    const big = 9_000_000_000_00; // 9 milyar TL, kuruş
    expect(classifyPriceChange(big, big - 1)).toMatchObject({ kind: "down", diffKurus: 1 });
  });

  it("geçersiz girdi karşılaştırma değildir", () => {
    for (const [a, b] of [
      [0, 100],
      [100, 0],
      [-5, 100],
      [100.5, 100],
      [Number.NaN, 100],
      [Number.MAX_SAFE_INTEGER + 2, 100],
    ]) {
      expect(classifyPriceChange(a as number, b as number)).toEqual({ kind: "insufficient" });
    }
  });
});
