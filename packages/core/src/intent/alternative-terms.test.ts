/**
 * karar 0210: dogrulanmis alternatif arama terimleri. Dogrulama suzgeci, slot genisletme ve
 * bayrak kapaliyken eski davranisin birebir korunmasi.
 */
import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import { buildTextSlots } from "../search/text-match.ts";
import type { QueryObject } from "../search/types.ts";
import {
  MAX_ALTERNATIVE_TERMS,
  mergeAlternativeTerms,
  validateAlternativeTerms,
} from "./alternative-terms.ts";
import {
  buildIntentV2JsonSchema,
  INTENT_V2_INSTRUCTIONS,
  intentV2ContractHash,
  intentV2Instructions,
} from "./contract.ts";
import { fromRawQuery } from "./normalized-query-adapter.ts";
import { applyIntentPlan, toSearchPlan } from "./to-search.ts";
import { validateIntentV2 } from "./validate.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "brand", surface: "xiaomi", normalized: "xiaomi", weight: 1 },
  { kind: "brand", surface: "sony", normalized: "sony", weight: 1 },
  { kind: "synonym", surface: "kablosuz", normalized: "wireless", weight: 1 },
  { kind: "synonym", surface: "wireless", normalized: "wireless", weight: 1 },
];

const alt = (text: string, for_text: string, lang: string | null = "en") => ({
  text,
  lang,
  for_text,
});
const ctx = (queryText: string) => ({ queryText, lexicon: LEXICON });
const raw = (terms: unknown) => ({ alternative_terms: terms });

describe("validateAlternativeTerms", () => {
  it("Turkce sorgu icin Ingilizce karsiligi kabul eder; dil null olabilir", () => {
    expect(
      validateAlternativeTerms(
        raw([alt("Headphones", "kulaklık"), alt("earphones", "kulaklık", null)]),
        ctx("kablosuz kulaklık"),
      ),
    ).toEqual([
      { text: "headphones", forText: "kulaklik", lang: "en" },
      { text: "earphones", forText: "kulaklik", lang: null },
    ]);
  });

  it("hedef dil Ingilizce ile sinirli degil (Almanca/Turkce karsilik da gecer)", () => {
    const out = validateAlternativeTerms(
      raw([alt("kopfhörer", "kulaklık", "de")]),
      ctx("kulaklık"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.lang).toBe("de");
  });

  it("alan yok, dizi degil ya da bozuk -> bos (eski kayit)", () => {
    for (const value of [{}, { alternative_terms: null }, { alternative_terms: "x" }, null, 5]) {
      expect(validateAlternativeTerms(value, ctx("kulaklık"))).toEqual([]);
    }
    expect(validateAlternativeTerms(raw([null, 3, "x", {}]), ctx("kulaklık"))).toEqual([]);
  });

  it("en fazla 3 terim", () => {
    const terms = ["headphones", "earphones", "headset", "earbuds", "airpods"].map((t) =>
      alt(t, "kulaklık"),
    );
    expect(validateAlternativeTerms(raw(terms), ctx("kulaklık"))).toHaveLength(
      MAX_ALTERNATIVE_TERMS,
    );
  });

  it("uzunluk, kelime sayisi, karakter, rakam, URL ve kisisel veri reddedilir", () => {
    const bad = [
      "ab",
      "a".repeat(41),
      "one two three four",
      "head-phones 2",
      "headphones123",
      "https://x.com",
      "www.shop.com",
      "ali@mail.com",
      "5551234567",
      "head_phones",
      "head<phones>",
    ];
    const out = validateAlternativeTerms(raw(bad.map((t) => alt(t, "kulaklık"))), ctx("kulaklık"));
    expect(out).toEqual([]);
  });

  it("tekrar ve orijinal sorguyla ayni terim atilir", () => {
    const out = validateAlternativeTerms(
      raw([
        alt("headphones", "kulaklık"),
        alt("Headphones", "kulaklık"),
        alt("kulaklık", "kulaklık"),
      ]),
      ctx("kulaklık"),
    );
    expect(out.map((t) => t.text)).toEqual(["headphones"]);
  });

  it("kanit: for_text sorguda birebir gecmiyorsa atilir", () => {
    expect(
      validateAlternativeTerms(
        raw([alt("headphones", "kulaklık"), alt("laptop", "dizüstü")]),
        ctx("kulaklık"),
      ).map((t) => t.text),
    ).toEqual(["headphones"]);
  });

  it("model yeni marka ekleyemez", () => {
    expect(
      validateAlternativeTerms(
        raw([alt("sony", "kulaklık"), alt("sony headphones", "kulaklık")]),
        ctx("kulaklık"),
      ),
    ).toEqual([]);
  });

  it("aksesuar istemeyen sorguda aksesuar/arac/parca terimi atilir", () => {
    const out = validateAlternativeTerms(
      raw([
        alt("phone case", "telefon"),
        alt("charger cable", "telefon"),
        alt("spare parts", "telefon"),
        alt("car", "telefon"),
        alt("smartphone", "telefon"),
      ]),
      ctx("telefon"),
    );
    expect(out.map((t) => t.text)).toEqual(["smartphone"]);
  });

  it("aksesuar isteyen sorguda aksesuar terimi engellenmez", () => {
    const out = validateAlternativeTerms(raw([alt("phone case", "kılıf")]), ctx("telefon kılıfı"));
    // for_text "kılıf" sorguda ("kilifi") birebir yok -> yine atilir; kanit kurali bagimsiz calisir.
    expect(out).toEqual([]);
    const ok = validateAlternativeTerms(raw([alt("phone cover", "kılıfı")]), ctx("telefon kılıfı"));
    expect(ok.map((t) => t.text)).toEqual(["phone cover"]);
  });

  it("'araba -> car' ornegi: arac alani sorgusunda gecer (bilinen yanlis pozitif riski, 0208)", () => {
    const out = validateAlternativeTerms(raw([alt("car", "araba")]), ctx("araba"));
    expect(out.map((t) => t.text)).toEqual(["car"]);
  });
});

describe("mergeAlternativeTerms", () => {
  const slots = buildTextSlots("kablosuz kulaklık", LEXICON);

  it("terimi kanit slotunun sonuna ekler; orijinal ve sira korunur", () => {
    const merged = mergeAlternativeTerms(slots, [
      { text: "headphones", forText: "kulaklik", lang: "en" },
    ]);
    expect(merged.slots).toEqual([
      ["kablosuz", "wireless"],
      ["kulaklik", "headphones"],
    ]);
    expect(merged.added).toHaveLength(1);
    // Girdi degismez.
    expect(slots).toEqual([["kablosuz", "wireless"], ["kulaklik"]]);
  });

  it("slotta zaten olan alternatif (es anlamli) eklenmez", () => {
    const merged = mergeAlternativeTerms(slots, [
      { text: "wireless", forText: "kablosuz", lang: "en" },
    ]);
    expect(merged.added).toEqual([]);
  });

  it("hicbir slota denk gelmeyen for_text atilir", () => {
    const merged = mergeAlternativeTerms(slots, [
      { text: "laptop", forText: "dizustu", lang: "en" },
    ]);
    expect(merged.added).toEqual([]);
  });

  it("toplam en fazla 3", () => {
    const terms = ["a1x", "b1x", "c1x", "d1x"].map((text) => ({
      text: text.replace(/1/, "z"),
      forText: "kulaklik",
      lang: null,
    }));
    expect(mergeAlternativeTerms(slots, terms).added).toHaveLength(3);
  });
});

describe("IntentV2 -> plan -> sorgu (uctan uca, modelsiz)", () => {
  const query = "kablosuz kulaklık";
  const reply = {
    schema_version: 2,
    product_type: { text: "kulaklık", type_id: null, evidence: "kulaklık" },
    role: "main",
    compatible_with: null,
    brand: null,
    excluded_brands: [],
    attributes: [],
    budget: null,
    price_preference: null,
    use_case: null,
    ambiguous_fields: [],
    clarification: null,
    alternative_terms: [alt("headphones", "kulaklık"), alt("sony", "kulaklık")],
  };
  const base = (): QueryObject => ({
    intent: "browse",
    anchor: null,
    text: query,
    filters: {},
    style_tags: [],
    sort: "balanced",
    unparsed: query,
    confidence: 0.5,
    text_slots: buildTextSlots(query, LEXICON),
  });
  const planOf = (value: unknown) =>
    toSearchPlan(validateIntentV2(value, { query: fromRawQuery(query), lexicon: LEXICON }));

  it("yalniz text_slots degisir; filtre, siralama alani ve unparsed ayni", () => {
    const before = base();
    const merged = applyIntentPlan(before, planOf(reply));
    expect(merged.text_slots).toEqual([
      ["kablosuz", "wireless"],
      ["kulaklik", "headphones"],
    ]);
    expect({ ...merged, text_slots: undefined, product_role: undefined }).toEqual({
      ...before,
      text_slots: undefined,
      product_role: undefined,
    });
  });

  it("text_slots yoksa unparsed tokenlarindan uretilir", () => {
    const before = { ...base(), text_slots: undefined };
    const merged = applyIntentPlan(before, planOf(reply));
    expect(merged.text_slots).toEqual([["kablosuz"], ["kulaklik", "headphones"]]);
  });

  it("alan yok (eski kayit) -> sorgu birebir ayni nesne olarak kalir", () => {
    const { alternative_terms: _drop, ...legacy } = reply;
    const before = base();
    const plan = planOf(legacy);
    expect(plan.hints.altTerms ?? []).toEqual([]);
    const merged = applyIntentPlan(before, { ...plan, hints: { ...plan.hints, role: null } });
    expect(merged.text_slots).toBe(before.text_slots);
  });

  it("cekirdek reddedilirse (gecersiz rol) terimler de uygulanmaz", () => {
    expect(planOf({ ...reply, role: "bogus" }).hints.altTerms ?? []).toEqual([]);
  });
});

describe("sozlesme: bayrak kapaliyken eski sozlesmeyle birebir", () => {
  it("ozet, talimat ve sema degismez; kayitli eski ozet korunur", () => {
    // origin/main (karar 0205 sonrasi) uzerinde olculen eski ozet.
    expect(intentV2ContractHash()).toBe(
      "75f5087bcca7c9e45ffb2a9e7884a6127b65a5886b813d783511477bc7a8edb7",
    );
    expect(intentV2ContractHash({ altTerms: false })).toBe(intentV2ContractHash());
    expect(intentV2Instructions()).toBe(INTENT_V2_INSTRUCTIONS);
    expect(Object.keys(buildIntentV2JsonSchema().properties)).not.toContain("alternative_terms");
  });

  it("bayrak acikken alan zorunlu, katı ve en fazla 3; ozet farkli", () => {
    const schema = buildIntentV2JsonSchema(undefined, { altTerms: true }) as unknown as {
      required: string[];
      properties: Record<string, { maxItems?: number }>;
    };
    expect(schema.required).toContain("alternative_terms");
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.alternative_terms?.maxItems).toBe(3);
    expect(intentV2ContractHash({ altTerms: true })).not.toBe(intentV2ContractHash());
    expect(intentV2Instructions({ altTerms: true })).toContain("alternative_terms");
  });
});
