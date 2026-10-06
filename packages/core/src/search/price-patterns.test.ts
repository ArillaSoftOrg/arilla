import { describe, expect, it } from "vitest";
import { extractPricePatterns } from "./price-patterns.ts";

describe("extractPricePatterns", () => {
  it("parses 'X tl altı' as an upper bound in kurus", () => {
    const [match] = extractPricePatterns("3000 tl altı siyah ayakkabı");
    expect(match).toMatchObject({ priceMax: 300000 });
    expect(match?.priceMin).toBeUndefined();
  });

  it("parses 'X altında' without the tl unit", () => {
    const [match] = extractPricePatterns("3000 altında bir şey");
    expect(match).toMatchObject({ priceMax: 300000 });
  });

  it("parses the '-X₺' shorthand", () => {
    const [match] = extractPricePatterns("-3000₺ ayakkabı");
    expect(match).toMatchObject({ priceMax: 300000 });
  });

  it("parses 'X-Y arası' as a range", () => {
    const [match] = extractPricePatterns("2000-3000 arası ayakkabı");
    expect(match).toMatchObject({ priceMin: 200000, priceMax: 300000 });
  });

  it("returns nothing when there is no price pattern", () => {
    expect(extractPricePatterns("siyah spor ayakkabı")).toHaveLength(0);
  });
});

describe("extractPricePatterns — Turkish shorthand (deterministic, TRY)", () => {
  const only = (text: string) => {
    const found = extractPricePatterns(text);
    expect(found, text).toHaveLength(1);
    return found[0];
  };

  it.each([
    ["20 bin altı telefon", { priceMax: 2_000_000 }],
    ["20 bin altında telefon", { priceMax: 2_000_000 }],
    ["20k altı telefon", { priceMax: 2_000_000 }],
    ["20.000 tl altı telefon", { priceMax: 2_000_000 }],
    ["20000 altı telefon", { priceMax: 2_000_000 }],
    ["2,5 bin altı kulaklık", { priceMax: 250_000 }],
    ["1,5 milyon altı araba", { priceMax: 150_000_000 }],
    ["en fazla 30k", { priceMax: 3_000_000 }],
    ["en çok 30 bin tl", { priceMax: 3_000_000 }],
    ["maksimum 5000 tl", { priceMax: 500_000 }],
    ["5000 tl'den ucuz", { priceMax: 500_000 }],
    ["5000'den ucuz", { priceMax: 500_000 }],
    ["5000 tl den daha ucuz", { priceMax: 500_000 }],
    ["20 bine kadar", { priceMax: 2_000_000 }],
    ["10 bin üstü", { priceMin: 1_000_000 }],
    ["10 bin tl ve üzeri", { priceMin: 1_000_000 }],
    ["10k üzeri", { priceMin: 1_000_000 }],
    ["en az 8 bin", { priceMin: 800_000 }],
    ["15 bin ile 25 bin arası laptop", { priceMin: 1_500_000, priceMax: 2_500_000 }],
    ["15 ile 25 bin arası laptop", { priceMin: 1_500_000, priceMax: 2_500_000 }],
    ["15-25 bin laptop", { priceMin: 1_500_000, priceMax: 2_500_000 }],
    ["15k-25k laptop", { priceMin: 1_500_000, priceMax: 2_500_000 }],
    ["25 bin ile 15 bin arası", { priceMin: 1_500_000, priceMax: 2_500_000 }],
  ])("%s", (text, expected) => {
    const match = only(text);
    expect(match).toMatchObject({ ...expected, currency: "TRY" });
    if (!("priceMin" in expected)) expect(match?.priceMin).toBeUndefined();
    if (!("priceMax" in expected)) expect(match?.priceMax).toBeUndefined();
    // Her tutar tamsayi kurus.
    for (const value of [match?.priceMin, match?.priceMax]) {
      if (value !== undefined) expect(Number.isInteger(value)).toBe(true);
    }
  });

  it.each([
    "iphone 17",
    "iphone 17 pro max",
    "iphone17 altı",
    "iphone 17 altı",
    "s24 ultra",
    "samsung s24 altı",
    "a15 altı telefon",
    "rtx4060 laptop",
    "128gb telefon",
    "128 gb altı telefon",
    "256 gb ssd",
    "5000 mah altı telefon",
    "6,7 inç ekran",
    "14-16 inç laptop",
    "en az 16 gb ram",
    "en fazla 3 taksit",
    "en az 2 yıl garanti",
    "120 hz ekran",
    "kask 2 adet",
  ])("does not treat '%s' as a price", (text) => {
    expect(extractPricePatterns(text)).toHaveLength(0);
  });

  it("reads the price and ignores the model number beside it", () => {
    const found = extractPricePatterns("iphone 17 pro max 256 gb 60 bin altı");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ priceMax: 6_000_000 });
  });

  it("'max'/'min' in a model name is not a price operator (iphone 17 pro max 60 bin altı)", () => {
    const text = "iphone 17 pro max 60 bin altı";
    const found = extractPricePatterns(text);
    expect(found).toHaveLength(1);
    // Yalnizca "60 bin altı" tuketilir; "max" modelde kalir.
    expect(text.slice(found[0]?.start, found[0]?.end)).toBe("60 bin altı");
    expect(extractPricePatterns("galaxy s24 min 5000 tl")).toHaveLength(0);
  });

  it("handles a decimal comma in lira amounts", () => {
    expect(only("1.299,90 tl altı")).toMatchObject({ priceMax: 129_990 });
  });

  it("rejects absurd amounts", () => {
    expect(extractPricePatterns("999999999 milyon altı")).toHaveLength(0);
  });

  it("every match carries TRY", () => {
    for (const text of ["3000 tl altı", "-3000₺", "2000-3000 arası", "20k altı"]) {
      for (const match of extractPricePatterns(text)) expect(match.currency).toBe("TRY");
    }
  });
});

describe("extractPricePatterns — why the bare-number rules are what they are", () => {
  // Her satir bir KURALI sabitler. Bir kural degisirse ilgili satir bilincli olarak degismeli.
  const priced = (text: string) => extractPricePatterns(text).length === 1;

  it.each([
    // [metin, fiyat mi, neden]
    ["3000 altı", true, "yuvarlak isaretsiz tutar + 'altı' isleci"],
    ["250 altı kulaklık", true, "100 TL tabaninin ustunde, 50'nin kati"],
    ["3500 altı", true, "50'nin kati"],
    ["2.999 altı", true, "binlik noktasi para bicimidir (yuvarlak olmasa da)"],
    ["en fazla 5000", true, "isleç once: >= 1000 ve yuvarlak"],
    ["2999 tl altı", true, "para birimi varsa bicim kurali uygulanmaz"],
    ["60 bin altı", true, "carpan varsa bicim kurali uygulanmaz"],
    ["iphone 17 altı", false, "17 < 100 tabani: model numarasi"],
    ["en az 16 ram", false, "16 < 1000 ve olcu birimi"],
    ["128 altı telefon", false, "128 tabanin ustunde ama 50'nin kati degil: depolama"],
    ["256 altı telefon", false, "ikili depolama boyutu"],
    ["512 altı", false, "ikili depolama boyutu"],
    ["1024 altı", false, "ikili boyut; 50'nin kati degil"],
    ["en az 2048", false, "isleç once, >= 1000 ama 50'nin kati degil"],
    ["en az 128 gb", false, "olcu birimi ('gb')"],
    [
      "2999 altı",
      false,
      "ISARETSIZ ve yuvarlak degil: bilincli temkin (yanlis filtre < filtresiz)",
    ],
    ["s24 altı", false, "harfe bitisik sayi"],
    ["rtx4060 altı", false, "harfe bitisik sayi"],
    ["128gb altı", false, "olcu birimi sayiyla isleç arasina girer"],
  ] as const)("%s -> price=%s (%s)", (text, expected, _reason) => {
    expect(priced(text)).toBe(expected);
  });

  it("a number alone, without a price operator or marker, is never a price", () => {
    for (const text of ["iphone 17 pro 256", "4000", "ürün 3000", "samsung 5000 mah", "20 bin"]) {
      expect(extractPricePatterns(text), text).toHaveLength(0);
    }
  });

  it("a large number alone does not make a price; the intent word does", () => {
    expect(extractPricePatterns("laptop 35000")).toHaveLength(0);
    expect(extractPricePatterns("laptop 35000 altı")).toHaveLength(1);
    expect(extractPricePatterns("laptop 35 bin altı")).toHaveLength(1);
  });
});
