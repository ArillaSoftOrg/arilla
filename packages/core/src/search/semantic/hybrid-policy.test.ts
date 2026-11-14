import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../lexicon.ts";
import {
  BGE_M3_HYBRID_POLICY,
  buildCandidateCheck,
  conditionalHybrid,
  type HybridPolicy,
  isNoiseTitle,
  negatedTerms,
  oppositeTerms,
  type PolicyCandidate,
  type PolicyTextItem,
  rejectReason,
  specTokens,
} from "./hybrid-policy.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "synonym", surface: "kablosuz", normalized: "kablosuz", weight: 1 },
  { kind: "synonym", surface: "wireless", normalized: "kablosuz", weight: 1 },
  { kind: "synonym", surface: "deri", normalized: "deri", weight: 1 },
  { kind: "synonym", surface: "leather", normalized: "deri", weight: 1 },
];

const text = (id: number, title: string, tier: PolicyTextItem["tier"] = "exact", sim = 0.45) =>
  ({ productId: id, title, tier, similarity: sim }) satisfies PolicyTextItem;
const cand = (id: number, title: string, similarity: number) =>
  ({ productId: id, title, similarity }) satisfies PolicyCandidate;

describe("aday temizligi", () => {
  it("urun olmayan ve tekrarli basliklari gurultu sayar", () => {
    expect(isNoiseTitle("top up the balance")).toBe(true);
    expect(isNoiseTitle("NO stock'NO stock'NO stock'NO stock'NO stock'")).toBe(true);
    expect(isNoiseTitle("Price difference link for shipping")).toBe(true);
    expect(isNoiseTitle("Kids Winter Snow Boots Warm Plush Non Slip")).toBe(false);
  });

  it("model ve teknik kodlari bicimden bagimsiz cikarir", () => {
    expect(specTokens("DDR5 32GB bellek")).toEqual(["ddr5", "32gb"]);
    expect(specTokens("Makita BL1830 batarya adaptörü")).toEqual(["bl1830"]);
    expect(specTokens("500 TL altı çocuk ayakkabısı")).toEqual([]);
    expect(specTokens("NVMe M.2 SSD 1TB")).toEqual(["m2", "1tb"]);
  });

  it("teknik kodu tasimayan anlamsal adayi reddeder, bicim farkini kabul eder", () => {
    const check = buildCandidateCheck("DDR5 32GB bellek", LEXICON);
    expect(rejectReason("KODAK USB3.2 Flash Drive 256GB 128GB 32GB", check)).toBe("spec_missing");
    expect(rejectReason("Avanshare Ram Memory DDR5 DDR4 32 GB 16GB", check)).toBeNull();
  });

  it("olumsuzlanan ozelligi sozluk esanlamlilariyla genisletir", () => {
    const negated = negatedTerms("kablosuz olmayan oyun klavyesi", LEXICON);
    expect([...negated]).toEqual(expect.arrayContaining(["kablosuz", "wireless", "bluetooth"]));
    const check = buildCandidateCheck("deri olmayan çocuk botu", LEXICON);
    expect(rejectReason("genuine leather toddler winter boots", check)).toBe("negated");
    expect(rejectReason("Kids Rain Boots Rubber Waterproof", check)).toBeNull();
  });

  it("'kablosuz' tek basina olumsuzluk degildir; ozelligin karsiti reddedilir", () => {
    expect(negatedTerms("kablosuz mouse", LEXICON).size).toBe(0);
    expect([...oppositeTerms("kablolu klavye", new Set())]).toEqual(
      expect.arrayContaining(["wireless", "bluetooth"]),
    );
    const check = buildCandidateCheck("kablolu klavye", LEXICON);
    expect(rejectReason("Wireless Bluetooth Keyboard Slim", check)).toBe("opposite_attribute");
  });

  it("sorgu aksesuar istemiyorsa aksesuar gorunumlu anlamsal aday eklenmez", () => {
    const check = buildCandidateCheck("kablosuz kulaklık", LEXICON);
    expect(rejectReason("Earphone Pouch Storage Case For Wireless Earbuds", check)).toBe(
      "accessory",
    );
  });
});

describe("kosullu siralama", () => {
  const strongText = [1, 2, 3, 4, 5, 6].map((i) => text(i, `Plush Warm House Slippers ${i}`));

  it("guclu lexical: ilk `strongKeep` sira korunur; goreli esigi gecemeyen aday hic girmez", () => {
    const check = buildCandidateCheck("ev terliği peluş", LEXICON);
    // lexical kosinus ortancasi 0,45; varsayilan goreli esik +0,05 => 0,50
    const below = conditionalHybrid(
      strongText,
      [cand(101, "Resin Polishing Tools Kit", 0.49)],
      check,
    );
    expect(below.mode).toBe("lexical_strong");
    expect(below.ranked.map((e) => e.productId)).toEqual([1, 2, 3, 4, 5, 6]);
    const above = conditionalHybrid(
      strongText,
      [cand(100, "Handmade Tea Tweezer Luxury Tongs", 0.505)],
      check,
    );
    // Bilinen sinir (E4 raporu): esigi gecen alakasiz aday korunan bloktan SONRA girebilir.
    expect(above.ranked.slice(0, BGE_M3_HYBRID_POLICY.strongKeep).map((e) => e.productId)).toEqual([
      1, 2, 3,
    ]);
    expect(above.ranked.findIndex((e) => e.productId === 100)).toBeGreaterThanOrEqual(
      BGE_M3_HYBRID_POLICY.strongKeep,
    );
  });

  it("dense en iyisi lexical'den cok uzaksa lexical guclu sayilmaz (harmanlama)", () => {
    const res = conditionalHybrid(
      strongText,
      [cand(100, "Winter Plush Slippers Women", 0.7)],
      buildCandidateCheck("ev terliği peluş", LEXICON),
    );
    expect(res.mode).toBe("blend");
  });

  it("lexical bosken ana liste bos kalir; adaylar ayri oneri olarak doner", () => {
    const res = conditionalHybrid(
      [],
      [cand(9, "Stroller Seat Cushion Breathable", 0.55), cand(10, "top up the balance", 0.6)],
      buildCandidateCheck("puset minderi", LEXICON),
    );
    expect(res.mode).toBe("suggestions_only");
    expect(res.ranked).toEqual([]);
    expect(res.suggestions.map((c) => c.productId)).toEqual([9]);
    expect(res.rejected.noise).toBe(1);
  });

  it("kalibre mutlak esik verilirse lexical bosken ana listeye alinabilir", () => {
    const policy: HybridPolicy = { ...BGE_M3_HYBRID_POLICY, emptyMinTop: 0.6 };
    const res = conditionalHybrid(
      [],
      [cand(9, "Kids Winter Snow Boots Warm", 0.72)],
      buildCandidateCheck("kışın sıcak tutan çocuk botu", LEXICON),
      policy,
    );
    expect(res.mode).toBe("semantic_only");
    expect(res.ranked.map((e) => e.productId)).toEqual([9]);
  });

  it("zayif lexical: harmanlama; esit puanda lexical once gelir", () => {
    const weak = [text(1, "Snow Boots Kids", "related"), text(2, "Rain Boots Kids", "related")];
    const res = conditionalHybrid(
      weak,
      [cand(50, "Winter Boots Children Warm Fur", 0.7)],
      buildCandidateCheck("çocuk kar botu", LEXICON),
      { ...BGE_M3_HYBRID_POLICY, semanticWeight: 1 },
    );
    expect(res.mode).toBe("blend");
    expect(res.ranked[0]?.productId).toBe(1);
    expect(res.ranked.map((e) => e.productId)).toContain(50);
  });

  it("lexical sonuc asla silinmez; olumsuzlanan ozellikli olan sona tasinir", () => {
    const items = [
      text(1, "Genuine Leather Kids Boots"),
      text(2, "Rubber Rain Boots Kids"),
      text(3, "Canvas Kids Boots"),
    ];
    const res = conditionalHybrid(
      items,
      [],
      buildCandidateCheck("deri olmayan çocuk botu", LEXICON),
    );
    expect(res.ranked.map((e) => e.productId).sort()).toEqual([1, 2, 3]);
    expect(res.ranked.at(-1)?.productId).toBe(1);
  });

  it("anlamsal aday lexical urunu teyit ederse kaynak 'both' olur", () => {
    const res = conditionalHybrid(
      [text(1, "DDR5 32GB Ram Memory", "close", 0.55)],
      [cand(1, "DDR5 32GB Ram Memory", 0.56)],
      buildCandidateCheck("DDR5 32GB bellek", LEXICON),
    );
    expect(res.ranked[0]?.source).toBe("both");
  });
});
