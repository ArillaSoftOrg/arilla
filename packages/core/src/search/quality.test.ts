import { describe, expect, it } from "vitest";
import { queryContentIneligibility } from "./interpretation-eligibility.ts";
import type { LexiconEntry } from "./lexicon.ts";
import { normalizeQueryText } from "./normalize.ts";
import {
  extractUnrecognizedTerms,
  isRecordableQuery,
  isSearchQualityRecordable,
} from "./quality.ts";

describe("isRecordableQuery — kişisel veri süzgeci", () => {
  it.each([
    "siyah deri çanta",
    "iphone 15 pro 256 gb",
    "2000-3000 tl arası koşu ayakkabısı",
    "10000 - 20000 tl laptop",
    "42 numara bot",
    "100ml parfüm",
    "çanta",
  ])("alışveriş sorgusu yazılır: %s", (query) => {
    expect(isRecordableQuery(query)).toBe(true);
  });

  it.each([
    ["e-posta", "ayse.yilmaz@gmail.com çanta"],
    ["@ işareti", "@kullanici önerisi"],
    ["telefon boşluklu", "0532 123 45 67"],
    ["telefon ülke kodlu", "+90 532 123 45 67 kargo"],
    ["telefon parantezli", "(212) 555-12-34"],
    ["telefon bitişik", "05321234567"],
    ["uzun rakam (TC kimlik)", "12345678901"],
    ["7 haneli rakam", "sipariş 1234567"],
    ["url", "https://ornek.com/urun"],
    ["www", "www.ornek.com.tr"],
    ["alan adı", "trendyol.com çanta"],
    ["adres mahalle", "atatürk mahallesi kargo"],
    ["adres sokak", "gül sokak no: 5"],
    ["adres cadde", "bağdat caddesi mağaza"],
  ])("yazılmaz: %s", (_label, query) => {
    expect(isRecordableQuery(query)).toBe(false);
  });

  it("boş ve 200 karakterden uzun sorgu yazılmaz", () => {
    expect(isRecordableQuery("")).toBe(false);
    expect(isRecordableQuery("a".repeat(200))).toBe(true);
    expect(isRecordableQuery("a".repeat(201))).toBe(false);
    expect(isRecordableQuery(undefined as unknown as string)).toBe(false);
  });
});

const ANALYTICS_BLOCKED: readonly [string, string][] = [
  ["bolunmus kimlik", "tc 123 456 789 01"],
  ["AIza anahtari", "AIzaSyD-abcdefghijklmnopqrstuvwxyz12"],
  ["sk- anahtari", "sk-proj_abcdefgh"],
  ["password=", "password=hunter2"],
  ["şifre:", "şifre: Gizli123"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"],
  ["uzun onaltilik", "deadbeefcafebabe0042"],
];

const ANALYTICS_RECORDABLE: readonly string[] = [
  "siyah elbise",
  "iphone 15 pro max kılıf",
  "nike air force 1 42 numara",
  "samsung galaxy s24 ultra 512 gb",
  "rtx 4090 ekran kartı 24gb",
];

/** Ozel nitelikli baglam bu degisiklikte search_query_day'de suzulmez. */
const SENSITIVE_SHOPPING: readonly string[] = [
  "hamile pantolonu",
  "diyabet çorabı",
  "yetişkin bezi",
  "engelli rampası",
  "cinsel sağlık ürünleri",
];

describe("isSearchQualityRecordable — search_query_day süzgeci", () => {
  it.each(ANALYTICS_BLOCKED)("yazılmaz: %s", (_label, raw) => {
    const queryNorm = normalizeQueryText(raw);
    // Bugün yazılıyordu: fark yalnızca kimlik/sır kontrolü.
    expect(isRecordableQuery(queryNorm)).toBe(true);
    expect(isSearchQualityRecordable(queryNorm)).toBe(false);
  });

  it.each(ANALYTICS_RECORDABLE)("alışveriş sorgusu yazılır: %s", (raw) => {
    expect(isSearchQualityRecordable(normalizeQueryText(raw))).toBe(true);
  });

  it.each(SENSITIVE_SHOPPING)(
    "özel nitelikli alışveriş sorgusu bugünkü gibi yazılır: %s",
    (raw) => {
      const queryNorm = normalizeQueryText(raw);
      expect(isSearchQualityRecordable(queryNorm)).toBe(true);
      expect(queryContentIneligibility(queryNorm)).toBe("sensitive");
    },
  );

  it("isRecordableQuery'nin reddettiği her şeyi reddeder", () => {
    for (const raw of ["ayse.yilmaz@gmail.com çanta", "0532 123 45 67", "https://ornek.com/urun"]) {
      expect(isSearchQualityRecordable(normalizeQueryText(raw))).toBe(false);
    }
    expect(isSearchQualityRecordable("")).toBe(false);
    expect(isSearchQualityRecordable("a".repeat(201))).toBe(false);
  });

  it("model aday kümesi değişmez: yeni reddedilen her sorgu modele zaten gitmiyordu", () => {
    // `selectInterpretationCandidates` search_query_day satırlarını
    // `queryContentIneligibility` ile yeniden süzer; burada yazılmayan bir
    // sorgu orada da reddediliyorsa aday kümesi aynı kalır.
    for (const [, raw] of ANALYTICS_BLOCKED) {
      expect(queryContentIneligibility(normalizeQueryText(raw))).not.toBeNull();
    }
  });
});

const LEXICON: LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "category", surface: "çanta", normalized: "aksesuar/canta", weight: 1 },
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
  { kind: "material", surface: "deri", normalized: "leather", weight: 1 },
  { kind: "synonym", surface: "kablosuz", normalized: "wireless", weight: 1 },
];

describe("extractUnrecognizedTerms", () => {
  it("sözlükte karşılığı olan kelimeler çıkmaz, kalanlar çıkar", () => {
    expect(extractUnrecognizedTerms("siyah deri çanta", LEXICON)).toEqual([]);
    expect(extractUnrecognizedTerms("siyah yoga matı", LEXICON)).toEqual(["yoga", "matı"]);
  });

  it("eş anlamlı ve 'tarzı' ile atlanan marka da sözlükte sayılır", () => {
    expect(extractUnrecognizedTerms("kablosuz kulaklık", LEXICON)).toEqual(["kulaklık"]);
    expect(extractUnrecognizedTerms("nike tarzı sneaker", LEXICON)).toEqual(["sneaker"]);
  });

  it("fiyat, beden, rakam ve bağlaçlar atılır", () => {
    expect(extractUnrecognizedTerms("500 tl altı 42 numara bot", LEXICON)).toEqual(["bot"]);
    expect(extractUnrecognizedTerms("100ml ve parfüm için", LEXICON)).toEqual(["parfüm"]);
  });

  it("noktalama temizlenir, tekrarlar tek, en fazla 8, uzun kelime atılır", () => {
    expect(extractUnrecognizedTerms("bot, bot!", LEXICON)).toEqual(["bot"]);
    const many = "aa bb cc dd ee ff gg hh ii jj";
    expect(extractUnrecognizedTerms(many, LEXICON)).toHaveLength(8);
    expect(extractUnrecognizedTerms(`${"x".repeat(41)} kemer`, LEXICON)).toEqual(["kemer"]);
  });

  it("büyük harf normalize edilir (Türkçe I/İ)", () => {
    expect(extractUnrecognizedTerms("SİYAH Kemer", LEXICON)).toEqual(["kemer"]);
  });
});
