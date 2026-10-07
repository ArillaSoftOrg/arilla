import { describe, expect, it } from "vitest";
import {
  type EligibilityInput,
  INTERPRETATION_MIN_DISTINCT_DAYS,
  INTERPRETATION_MIN_OCCURRENCES,
  interpretationIneligibility,
  isEligibleForInterpretation,
  SENSITIVE_PATTERNS,
  sensitiveCategory,
} from "./interpretation-eligibility.ts";

const ok = (queryNorm: string, occurrences = 5, distinctDays = 4): EligibilityInput => ({
  queryNorm,
  occurrences,
  distinctDays,
});

describe("esik: toplam arama ve farkli gun", () => {
  it("en az 3 arama VE en az 3 farkli gun", () => {
    expect(INTERPRETATION_MIN_OCCURRENCES).toBe(3);
    expect(INTERPRETATION_MIN_DISTINCT_DAYS).toBe(3);
    expect(interpretationIneligibility(ok("bisiklet kaski", 3, 3))).toBeNull();
    expect(interpretationIneligibility(ok("bisiklet kaski", 2, 3))).toBe("too_few");
    expect(interpretationIneligibility(ok("bisiklet kaski", 0, 0))).toBe("too_few");
  });

  it("tek gunde cok tekrar (tek kisi gibi) esigi asamaz", () => {
    expect(interpretationIneligibility(ok("bisiklet kaski", 500, 1))).toBe("too_few_days");
    expect(interpretationIneligibility(ok("bisiklet kaski", 50, 2))).toBe("too_few_days");
  });

  it("gecersiz sayilar reddedilir", () => {
    expect(
      interpretationIneligibility({ queryNorm: "kask", occurrences: "5", distinctDays: 3 }),
    ).toBe("too_few");
    expect(
      interpretationIneligibility({ queryNorm: "kask", occurrences: 3.5, distinctDays: 3 }),
    ).toBe("too_few");
    expect(
      interpretationIneligibility({ queryNorm: "kask", occurrences: 5, distinctDays: "3" }),
    ).toBe("too_few_days");
    expect(
      interpretationIneligibility({ queryNorm: "kask", occurrences: 5, distinctDays: 2.5 }),
    ).toBe("too_few_days");
  });

  it("girdi yalnizca sorgu, sayi ve gun; kimlik alani yok", () => {
    const keys = Object.keys(ok("kask")).sort();
    expect(keys).toEqual(["distinctDays", "occurrences", "queryNorm"]);
  });
});

describe("siradan alisveris sorgulari uygun kalir", () => {
  it.each([
    "bisiklet kaski",
    "kablosuz-bluetooth-kulaklik",
    "iphone15promax kilif",
    "42 numara kosu ayakkabisi 2000 tl alti",
    "skechers spor ayakkabi",
    "babama hediye",
    "seksen derece termos",
    "seksi elbise",
    "yuksek bel jean",
    "dusuk bel jean",
    "kirmizi tisort",
    "parti malzemeleri",
    "gebze teslimat",
  ])("%s", (q) => {
    expect(sensitiveCategory(q)).toBeNull();
    expect(isEligibleForInterpretation(ok(q))).toBe(true);
  });
});

describe("mevcut suzgecler korunur", () => {
  it("yalnizca normalize sorgu ve uzunluk", () => {
    expect(interpretationIneligibility(ok("  Kask  "))).toBe("not_normalized");
    expect(interpretationIneligibility(ok("kask  siyah"))).toBe("not_normalized");
    expect(interpretationIneligibility({ queryNorm: 42, occurrences: 5, distinctDays: 4 })).toBe(
      "not_normalized",
    );
    expect(interpretationIneligibility(ok("k"))).toBe("length");
    expect(interpretationIneligibility(ok("a".repeat(121)))).toBe("length");
  });

  it.each(["ali.veli@ornek.com", "mail ali@x kask", "https://site.com/urun", "www.ornek.com.tr"])(
    "e-posta/URL: %s",
    (q) => {
      expect(interpretationIneligibility(ok(q))).toBe("personal_data");
    },
  );

  it.each(["0532 123 45 67", "+90 532 123 45 67", "(212) 555-12-34", "kask 05321234567"])(
    "telefon: %s",
    (q) => {
      expect(interpretationIneligibility(ok(q))).not.toBeNull();
    },
  );

  it.each([
    ["12345678901", "personal_data"],
    ["tc 123 456 789 01", "id_like"],
    ["siparis 1234 5678 99", "id_like"],
  ])("kimlik/uzun rakam: %s", (q, reason) => {
    expect(interpretationIneligibility(ok(q))).toBe(reason);
  });

  it.each([
    "sk-proj-abc123def456",
    "ghp_abcdefghijkl12",
    "xoxb-123456-abcdef",
    "aizasyabcdefghijklmnopqrstuvw",
    "eyjhbgcioijiuzi1niis",
    "password=hunter2",
    "sifre: gizli123",
    "şifre: gizli",
    "api key = abcdef",
    "token: abc",
    "a1b2c3d4xyzwqrstuv",
    "deadbeefcafebabe0011",
    "x7k9p2m4q8r1t5w3",
  ])("sir/token: %s", (q) => {
    expect(interpretationIneligibility(ok(q))).toBe("secret_like");
  });
});

describe("ozel nitelikli veri baglami (KVKK m.6)", () => {
  it.each([
    ["seker hastasi icin corap", "health"],
    ["şeker hastası için çorap", "health"],
    ["kanser hastasi icin hediye", "health"],
    ["diyabetik ayakkabi", "health"],
    ["depresyon icin kitap", "health"],
    ["otizmli cocuk oyuncak", "health"],
    ["hiv testi", "health"],
    ["alzheimer hastalari icin saat", "health"],
    ["hamileyim ne giysem", "pregnancy"],
    ["hamile pantolonu", "pregnancy"],
    ["gebelik testi", "pregnancy"],
    ["tup bebek takviyesi", "pregnancy"],
    ["yetiskin bezi", "disability"],
    ["idrar kacirma pedi", "disability"],
    ["engelli araci", "disability"],
    ["alevi cemevi hediyesi", "religion"],
    ["dinim icin kolye", "religion"],
    ["yahudi takvimi", "religion"],
    ["chp rozeti", "political"],
    ["iyi parti bayragi", "political"],
    ["siyasi gorus tisort", "political"],
    ["lgbt bayragi", "sexual"],
    ["escinsel cift hediye", "sexual"],
    ["cinsel saglik urunu", "sexual"],
    ["seks oyuncagi", "sexual"],
    ["dna testi", "genetic_biometric"],
    ["genetik test kiti", "genetic_biometric"],
    ["biyometrik kilit", "genetic_biometric"],
    ["sabika kaydi", "criminal"],
    ["sendika rozeti", "union"],
  ] as const)("%s -> %s", (q, category) => {
    expect(sensitiveCategory(q)).toBe(category);
    expect(interpretationIneligibility(ok(q))).toBe("sensitive");
  });

  it("bilinen, kabul edilmis yanlis pozitifler (temkinli tasarim)", () => {
    // Es yazimli kelimeler: "alevi" (alevin belirtme hali) ile din kimligi ayni
    // yazilir. Deterministik suzgec ayirt edemez; sorgu yorumlanmaz, deterministik
    // arama aynen calisir. Tasarim yanlis pozitifi yanlis negatife tercih eder.
    expect(sensitiveCategory("mangal alevi")).toBe("religion");
    expect(sensitiveCategory("hamile pantolonu")).toBe("pregnancy");
    expect(sensitiveCategory("biyometrik kilit")).toBe("genetic_biometric");
  });

  it("Turkce harfli ve harfsiz yazim ayni sonucu verir", () => {
    expect(sensitiveCategory("hamileyim")).toBe(sensitiveCategory("hamıleyım".replace(/ı/g, "i")));
    expect(sensitiveCategory("engelli")).toBe("disability");
    expect(sensitiveCategory("şeker hastası")).toBe(sensitiveCategory("seker hastasi"));
  });

  it("liste kucuk ve denetlenebilir; deterministik", () => {
    expect(SENSITIVE_PATTERNS.length).toBeLessThanOrEqual(20);
    for (const q of ["seker hastasi", "bisiklet kaski"]) {
      expect(sensitiveCategory(q)).toBe(sensitiveCategory(q));
    }
  });
});
