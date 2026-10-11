import { describe, expect, it } from "vitest";
import { candidatesFromAnnotatedText } from "./parse.ts";

describe("candidatesFromAnnotatedText", () => {
  const text =
    "- AYNI | Sony WH-1000XM5 | Hepsiburada\n- BENZER | Bose QC45 | Trendyol\n- AYNI | Arama | X";
  const line2 = text.indexOf("- BENZER");
  const resolved = new Map<string, string | null>([
    ["r1", "https://www.hepsiburada.com/sony-wh-1000xm5-p-HBC1"],
    ["r2", "https://www.trendyol.com/bose/qc45-p-123"],
    ["r3", "https://www.google.com/search?q=x"],
  ]);

  it("binds each line to the grounded url that covers it", () => {
    const out = candidatesFromAnnotatedText(
      text,
      [
        { url: "r1", startIndex: 2, endIndex: 30 },
        { url: "r2", startIndex: line2 + 2, endIndex: line2 + 20 },
      ],
      resolved,
    );
    expect(out.map((c) => [c.declaredKind, c.url.host])).toEqual([
      ["exact", "hepsiburada.com"],
      ["similar", "trendyol.com"],
    ]);
    expect(out.every((c) => c.priceKurus === null && c.priceStatus === "unverified")).toBe(true);
  });

  it("drops lines without a safe citation", () => {
    const last = text.lastIndexOf("- AYNI");
    expect(
      candidatesFromAnnotatedText(
        text,
        [{ url: "r3", startIndex: last, endIndex: last + 5 }],
        resolved,
      ),
    ).toEqual([]);
    expect(candidatesFromAnnotatedText(text, [{ url: "r1" }], resolved)).toEqual([]);
  });
});
