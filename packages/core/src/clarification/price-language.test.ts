import { describe, expect, it } from "vitest";
import { extractFacts } from "./extract.ts";
import { extractConversationalBudget, normalizeThousands } from "./price-language.ts";
import { TEST_CONTEXT } from "./test-fixtures.ts";

function budgetOf(text: string) {
  return extractFacts(text, TEST_CONTEXT).budget;
}

describe("konusma dilinde fiyat", () => {
  it.each([
    ["5 bin lirayı geçmesin", null, 500_000],
    ["5000'i geçmesin", null, 500_000],
    ["5.000 tl'yi aşmasın", null, 500_000],
    ["en fazla 5000", null, 500_000],
    ["en çok 5 bin tl", null, 500_000],
    ["5 bine kadar", null, 500_000],
    ["5000 tl altı", null, 500_000],
    ["en az 2000", 200_000, null],
    ["1000-2000 arası", 100_000, 200_000],
    ["1000 ile 2000 arası", 100_000, 200_000],
    ["2 bin civarı", 160_000, 240_000],
    ["2,5 bin civarında", 200_000, 300_000],
  ])("%s", (text, minKurus, maxKurus) => {
    expect(budgetOf(text)).toEqual({ minKurus, maxKurus });
  });

  it.each(["iphone 16", "5000", "2 bin", "5 kişilik çadır", "16 gb"])(
    "fiyat kelimesi olmadan sayi fiyat sayilmaz: %s",
    (text) => {
      expect(budgetOf(text)).toBeNull();
    },
  );

  it("'bin' yalnizca sayiyla birlikte ve kelime olarak okunur", () => {
    expect(normalizeThousands("5 bin").trim()).toBe("5000");
    expect(normalizeThousands("2,5 bin").trim()).toBe("2500");
    expect(normalizeThousands("binlerce ürün")).toBe("binlerce ürün");
    expect(normalizeThousands("2.500 tl")).toBe("2.500 tl");
  });

  it("uzunluk korunur (indeksler kaymaz)", () => {
    const text = "kask 5 bin lirayı geçmesin";
    expect(extractConversationalBudget(text).rest).toHaveLength(text.length);
  });

  it("fiyat ifadesi metin kapisina sizmaz", () => {
    const facts = extractFacts("siyah koşu ayakkabısı 5 bin lirayı geçmesin", TEST_CONTEXT);
    expect(facts.terms).toEqual([]);
    expect(facts.budget).toEqual({ minKurus: null, maxKurus: 500_000 });
  });
});
