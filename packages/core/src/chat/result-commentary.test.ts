import { describe, expect, it } from "vitest";
import { buildResultCommentary, COMMENTARY_MIN_ITEMS } from "./result-commentary.ts";

const item = (price: number | null, merchant?: string, brand?: string) => ({
  minPrice: price,
  merchantName: merchant ?? null,
  brandName: brand ?? null,
});

const FORBIDDEN = /ucuz|satın al|dupe|en iyi|mükemmel|harika/i;
const joined = (result: ReturnType<typeof buildResultCommentary>) =>
  result?.sentences.join(" ") ?? "";

describe("buildResultCommentary", () => {
  it("is silent for too few products", () => {
    expect(buildResultCommentary([item(10_000), item(20_000)])).toBeNull();
    expect(COMMENTARY_MIN_ITEMS).toBe(3);
    expect(buildResultCommentary([])).toBeNull();
  });

  it("states the verified price range and median in TL (kuruş converted)", () => {
    const text = joined(
      buildResultCommentary([item(100_000), item(250_000), item(400_000)], { seed: "x" }),
    );
    expect(text).toContain("1.000 TL");
    expect(text).toContain("4.000 TL");
    expect(text).toContain("2.500 TL");
  });

  it("describes stores and a dominant brand, never product titles", () => {
    const text = joined(
      buildResultCommentary(
        [
          item(10_000, "A Mağaza", "Philips"),
          item(20_000, "A Mağaza", "Philips"),
          item(30_000, "B Mağaza", "Philips"),
          item(40_000, "C Mağaza", "Xiaomi"),
        ],
        { seed: "lamba" },
      ),
    );
    expect(text).toMatch(/3 (farklı )?mağaza/);
    expect(text).toContain("A Mağaza");
    expect(text).toContain("Philips markası öne çıkıyor (3 / 4)");
  });

  it("reports products without a price and excludes them from the range", () => {
    const text = joined(
      buildResultCommentary([item(10_000), item(20_000), item(null), item(null)], { seed: "a" }),
    );
    expect(text).toContain("2 üründe fiyat bilgisi yok");
    expect(text).toContain("100 TL");
    expect(text).toContain("200 TL");
  });

  it("single price level and one-store results get plain, honest sentences", () => {
    const text = joined(
      buildResultCommentary([item(50_000, "Tek"), item(50_000, "Tek"), item(50_000, "Tek")]),
    );
    expect(text).toContain("500 TL civarında");
    expect(text).toContain("hepsi Tek mağazasından");
  });

  it("notes foreign (approximate) prices", () => {
    const text = joined(
      buildResultCommentary([
        { minPrice: 10_000, foreignPrice: { currency: "USD" } },
        item(20_000),
        item(30_000),
      ]),
    );
    expect(text).toContain("yurt dışı");
  });

  it("is deterministic per seed and varies the wording across seeds", () => {
    const items = [item(10_000), item(20_000), item(30_000)];
    expect(buildResultCommentary(items, { seed: "masa lambası" })).toEqual(
      buildResultCommentary(items, { seed: "masa lambası" }),
    );
    const forms = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h", "ı", "kulaklık", "mont", "ayakkabı"].map(
        (seed) => buildResultCommentary(items, { seed })?.sentences[0],
      ),
    );
    expect(forms.size).toBeGreaterThan(1);
  });

  it("never uses forbidden UI words, never all-caps, never claims quality", () => {
    for (const seed of ["a", "b", "c", "lamba", "telefon", "x1"]) {
      const result = buildResultCommentary(
        [item(10_000, "A", "B"), item(20_000, "A", "B"), item(30_000, "C", "B"), item(null)],
        { seed },
      );
      for (const sentence of result?.sentences ?? []) {
        expect(sentence).not.toMatch(FORBIDDEN);
        expect(sentence).not.toMatch(/\b[A-ZÇĞİÖŞÜ]{4,}\b/);
      }
    }
  });

  it("caps the output at four sentences", () => {
    const result = buildResultCommentary(
      [
        { minPrice: 10_000, merchantName: "A", brandName: "B", foreignPrice: {} },
        { minPrice: 20_000, merchantName: "C", brandName: "B" },
        { minPrice: 30_000, merchantName: "D", brandName: "B" },
        { minPrice: null, merchantName: "A", brandName: "B" },
      ],
      { seed: "s" },
    );
    expect(result?.sentences.length).toBeLessThanOrEqual(4);
  });
});
