import { describe, expect, it } from "vitest";
import { normalizeQueryText, normalizeSizeToken } from "./normalize.ts";

describe("normalizeQueryText", () => {
  it("lowercases Turkish text with correct dotted/dotless i rules", () => {
    expect(normalizeQueryText("SİYAH Ayakkabı")).toBe("siyah ayakkabı");
  });

  it("collapses repeated whitespace and trims", () => {
    expect(normalizeQueryText("  siyah   spor  ayakkabı  ")).toBe("siyah spor ayakkabı");
  });

  it("treats case variants of the same word identically", () => {
    expect(normalizeQueryText("Siyah")).toBe(normalizeQueryText("siyah"));
  });
});

describe("normalizeSizeToken", () => {
  it("lowercases letter sizes", () => {
    expect(normalizeSizeToken("M")).toBe("m");
  });

  it("keeps numeric sizes as-is", () => {
    expect(normalizeSizeToken("42")).toBe("42");
  });

  it("hyphenates multi-word sizes", () => {
    expect(normalizeSizeToken("Tek ebat")).toBe("tek-ebat");
  });
});
