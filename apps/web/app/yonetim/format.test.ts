import { describe, expect, it } from "vitest";
import { formatForeignPrices, formatKurus, formatMinor } from "./format.ts";

describe("formatMinor (karar 0113/0127)", () => {
  it("TRY kuruş TL olarak yazılır", () => {
    expect(formatMinor(129990, "TRY")).toBe(formatKurus(129990));
  });

  it("USD cent TL'ye çevrilmez ve TL gibi yazılmaz", () => {
    expect(formatMinor(1999, "USD")).toBe("19,99 USD");
    expect(formatMinor(123456700, "USD")).toBe("1.234.567,00 USD");
    expect(formatMinor(1999, "USD")).not.toContain("TL");
  });

  it("fiyat yoksa tire", () => {
    expect(formatMinor(null, "USD")).toBe("—");
  });

  it("para birimi başına en düşük yurt dışı fiyatlar", () => {
    expect(
      formatForeignPrices([
        { currency: "EUR", minPrice: 999 },
        { currency: "USD", minPrice: 1999 },
      ]),
    ).toBe("9,99 EUR · 19,99 USD");
    expect(formatForeignPrices([])).toBe("—");
  });
});
