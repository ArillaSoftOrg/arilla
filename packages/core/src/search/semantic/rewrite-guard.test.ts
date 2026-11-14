import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../lexicon.ts";
import { verifyCanonicalQuery, verifyRewrite } from "./rewrite-guard.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "synonym", surface: "kablosuz", normalized: "kablosuz", weight: 1 },
  { kind: "synonym", surface: "wireless", normalized: "kablosuz", weight: 1 },
  { kind: "synonym", surface: "deri", normalized: "deri", weight: 1 },
  { kind: "synonym", surface: "leather", normalized: "deri", weight: 1 },
];
const BRANDS = ["DeWalt", "Makita", "Samsung"];

describe("yeniden yazim dogrulayicisi (E4-b)", () => {
  it.each([
    ["kabin boy valiz", "cabin size carry-on suitcase"],
    ["puset minderi", "stroller seat cushion"],
    ["DDR5 32GB bellek", "DDR5 32GB RAM memory"],
    ["DeWalt 20V batarya tutucu", "DeWalt 20V battery holder"],
    ["kablosuz olmayan oyun klavyesi", "wired gaming keyboard"],
    ["kablosuz olmayan oyun klavyesi", "non-wireless gaming keyboard"],
    ["deri olmayan çocuk botu", "leather-free kids boots"],
  ])("%s -> %s kabul edilir", (raw, rewrite) => {
    expect(verifyRewrite(raw, rewrite, LEXICON, BRANDS)).toEqual({ accepted: true, reason: null });
  });

  it.each([
    ["DDR5 32GB bellek", "DDR4 32GB RAM", "spec_lost"],
    ["Makita BL1830 batarya adaptörü", "Makita BL1850 battery adapter", "spec_lost"],
    ["kablosuz olmayan oyun klavyesi", "wireless gaming keyboard", "negation_flipped"],
    ["deri olmayan çocuk botu", "kids leather boots", "negation_flipped"],
    ["DeWalt 20V batarya tutucu", "20V battery holder", "brand_lost"],
    ["çocuk ayakkabısı", "kids shoes under 500", "number_invented"],
    ["laptop", "", "empty"],
    ["laptop", "laptop https://example.com", "unsafe_content"],
  ])("%s -> %s reddedilir (%s)", (raw, rewrite, reason) => {
    expect(verifyRewrite(raw, rewrite, LEXICON, BRANDS)).toEqual({ accepted: false, reason });
  });
});

describe("dil bagimsiz kanonik yazim sozlesmesi (E4b C+)", () => {
  const ctx = (extra: Partial<Parameters<typeof verifyCanonicalQuery>[4]> = {}) => ({
    lexicon: LEXICON,
    requiredEntities: [] as string[],
    ...extra,
  });
  const lang = (tag: string, confidence = "high") => ({ tag, confidence });
  const rw = (text: string | null, language = "en") => (text === null ? null : { language, text });

  it("Almanca olumsuzluk kanitli dislamayla korunur; olumluya cevrilirse reddedilir", () => {
    const ex = [{ text: "bluetooth", evidence: "ohne Bluetooth" }];
    const ok = verifyCanonicalQuery(
      "Tastatur ohne Bluetooth",
      lang("de"),
      rw("wired keyboard"),
      ex,
      ctx(),
    );
    expect(ok).toMatchObject({
      accepted: true,
      verifiedExcluded: ["bluetooth"],
      negationCheck: "cue_table",
    });
    const bad = verifyCanonicalQuery(
      "Tastatur ohne Bluetooth",
      lang("de"),
      rw("bluetooth keyboard"),
      ex,
      ctx(),
    );
    expect(bad.reason).toBe("negation_flipped");
  });

  it("kaniti ham metinde olmayan dislama yok sayilir; olumsuzluk cozumsuzse reddedilir", () => {
    const res = verifyCanonicalQuery(
      "Tastatur ohne Bluetooth",
      lang("de"),
      rw("gaming keyboard"),
      [{ text: "bluetooth", evidence: "kein Bluetooth" }],
      ctx(),
    );
    expect(res).toMatchObject({
      accepted: false,
      reason: "negation_unresolved",
      verifiedExcluded: [],
    });
  });

  it("tabloda olmayan dil kabul edilir; olumsuzluk denetimi yalniz kanitli model dislamasiyla yapilir", () => {
    const res = verifyCanonicalQuery(
      "teclado sem fio",
      lang("pt"),
      rw("wireless keyboard"),
      [],
      ctx(),
    );
    expect(res).toMatchObject({ accepted: true, negationCheck: "model_evidence_only" });
  });

  it("kabul listesi verilirse disindaki dil geri duser; und ve dusuk guven her zaman geri duser", () => {
    expect(
      verifyCanonicalQuery(
        "x y",
        lang("sw"),
        rw("keyboard"),
        [],
        ctx({ acceptedQueryLanguages: ["tr", "en"] }),
      ).reason,
    ).toBe("language_unsupported");
    expect(verifyCanonicalQuery("x y", lang("und"), rw("keyboard"), [], ctx()).reason).toBe(
      "language_uncertain",
    );
    expect(verifyCanonicalQuery("x y", lang("de", "low"), rw("keyboard"), [], ctx()).reason).toBe(
      "language_uncertain",
    );
  });

  it.each([
    ["yazim yok", rw(null), "no_rewrite"],
    ["fiyat eklendi", rw("cheap kids shoes"), "price_added"],
    ["fiyat ve sayi eklendi", rw("kids shoes under 20 dollars"), "number_invented"],
    ["Turkce hedef dilde de fiyat eklenemez", rw("ucuz çocuk ayakkabısı", "tr"), "price_added"],
  ])("%s -> %s", (_name, r, reason) => {
    expect(verifyCanonicalQuery("Kinderschuhe", lang("de"), r, [], ctx()).reason).toBe(reason);
  });

  it("hedef dil Ingilizce olmak zorunda degil (DE sorgu -> TR katalog yazimi)", () => {
    const res = verifyCanonicalQuery(
      "Windeln Größe 2 für Neugeborene",
      lang("de"),
      rw("yenidoğan bebek bezi 2 beden", "tr"),
      [],
      ctx(),
    );
    expect(res.accepted).toBe(true);
  });

  it("marka/uyumlu cihaz korunmali; ondalik ayirici dilden bagimsiz", () => {
    const r = verifyCanonicalQuery(
      "DeWalt 20V Akku Halterung",
      lang("de"),
      rw("20V battery holder"),
      [],
      ctx({ requiredEntities: ["DeWalt"] }),
    );
    expect(r.reason).toBe("required_entity_lost");
    expect(
      verifyCanonicalQuery(
        "15,6 inç laptop çantası",
        lang("tr"),
        rw("15.6 inch laptop bag"),
        [],
        ctx(),
      ).accepted,
    ).toBe(true);
  });

  it("olumsuzluk korumasi dil bagimsizdir (TR/DE/EN ipuclari ve -free)", () => {
    const ex = (term: string, evidence: string) => [{ text: term, evidence }];
    for (const [raw, text, lng, term, evd] of [
      ["deri olmayan çocuk botu", "deri olmayan çocuk botu", "tr", "deri", "deri olmayan"],
      [
        "Gaming Tastatur ohne Bluetooth",
        "bluetooth olmayan oyuncu klavyesi",
        "tr",
        "bluetooth",
        "ohne Bluetooth",
      ],
      [
        "storage container that is not plastic",
        "plastik olmayan saklama kabı",
        "tr",
        "plastik",
        "not plastic",
      ],
      ["kids boots not leather", "leather-free kids boots", "en", "leather", "not leather"],
    ] as const) {
      expect(
        verifyCanonicalQuery(raw, lang("tr"), rw(text, lng), ex(term, evd), ctx()).accepted,
      ).toBe(true);
    }
  });

  it("hedef dil farkliyken cevrilmemis yazim kullanilmaz; ayni dilde ham sorgu kabul", () => {
    expect(
      verifyCanonicalQuery("mantı kalıbı", lang("tr"), rw("mantı kalıbı", "en"), [], ctx()).reason,
    ).toBe("not_translated");
    expect(
      verifyCanonicalQuery("mantı kalıbı", lang("tr"), rw("mantı kalıbı", "tr"), [], ctx())
        .accepted,
    ).toBe(true);
  });

  it("capraz dil anlam kaymasi esigin altindaysa reddedilir", () => {
    const r = verifyCanonicalQuery(
      "kabin boy valiz",
      lang("tr"),
      rw("kids backpack for boys"),
      [],
      ctx({ crossLingualCosine: 0.3 }),
    );
    expect(r.reason).toBe("intent_drift");
  });
});
