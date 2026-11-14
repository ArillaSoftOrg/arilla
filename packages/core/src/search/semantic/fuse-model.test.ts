import { describe, expect, it } from "vitest";
import type { RankedSearchItem } from "../fallback/types.ts";
import type { LexiconEntry } from "../lexicon.ts";
import { fuseForIndex } from "./fuse-model.ts";
import { BGE_M3_HYBRID_POLICY } from "./hybrid-policy.ts";
import { fuseForQuery } from "./shadow.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "synonym", surface: "deri", normalized: "deri", weight: 1 },
  { kind: "synonym", surface: "leather", normalized: "deri", weight: 1 },
];

function item(
  id: number,
  title: string,
  tier: "exact" | "close" | "related" = "exact",
): RankedSearchItem {
  return {
    productId: id,
    publicId: `p${id}`,
    slug: `s${id}`,
    title,
    primaryImageUrl: null,
    minPrice: 1000,
    brandName: null,
    categoryPath: null,
    merchantTrustScore: 80,
    inStock: true,
    currentPercentile: null,
    listPriceInflated: false,
    offerCount: 1,
    score: 1,
    match: { tier, score: 1, stage: "exact", relaxed: [], missing: [] },
  };
}

const cand = (id: number, title: string, similarity: number) => ({
  productId: id,
  title,
  similarity,
});

describe("rrf_gate (Jina): mevcut davranis DEGISMEZ", () => {
  it("fuseForQuery ile birebir ayni sira ve kaynak", () => {
    const items = [item(1, "Kosu ayakkabisi 1"), item(2, "Kosu ayakkabisi 2")];
    const cands = [cand(2, "Kosu ayakkabisi 2", 0.8), cand(9, "Kosu ayakkabisi 9", 0.79)];
    const sim = new Map([[2, 0.8]]);
    const out = fuseForIndex("rrf_gate", items, cands, "kosu ayakkabisi", sim, LEXICON);
    const legacy = fuseForQuery(items, cands, "kosu ayakkabisi", sim).fused;
    expect(out.entries.map((e) => [e.productId, e.source])).toEqual(
      legacy.map((e) => [e.item.productId, e.source]),
    );
    expect(out.mode).toBeNull();
    // `kind` verilmezse (eski SemanticIndex'ler) ayni yol
    expect(fuseForIndex(undefined, items, cands, "kosu ayakkabisi", sim, LEXICON)).toEqual(out);
  });
});

describe("conditional_hybrid (BGE-M3)", () => {
  const strongText = [
    item(1, "Kosu Ayakkabisi Erkek Siyah"),
    item(2, "Kosu Ayakkabisi Kadin Beyaz"),
    item(3, "Spor Kosu Ayakkabisi Hafif"),
    item(4, "Kosu Ayakkabisi Cocuk"),
  ];
  const textSim = new Map([
    [1, 0.55],
    [2, 0.54],
    [3, 0.53],
    [4, 0.5],
  ]);

  it("metin sonucu HIC dusmez ve guclu lexical blogunun sirasi korunur", () => {
    const cands = [
      cand(10, "Trail Kosu Ayakkabisi Su Gecirmez", 0.6),
      cand(11, "Yol Kosu Ayakkabisi Yastikli", 0.59),
    ];
    const out = fuseForIndex(
      "conditional_hybrid",
      strongText,
      cands,
      "kosu ayakkabisi",
      textSim,
      LEXICON,
    );
    expect(out.mode).toBe("lexical_strong");
    const ids = out.entries.map((e) => e.productId);
    for (const t of strongText) expect(ids).toContain(t.productId);
    expect(ids.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("aday temizligi: olumsuzlanan ozellik, aksesuar, gurultu ve teknik kod uyusmazligi eklenmez", () => {
    const cands = [
      cand(20, "Deri Kosu Ayakkabisi Siyah", 0.6), // sorguda "deri olmayan"
      // Aksesuar korumasi (karar 0170) bugun yalniz Ingilizce basliklari tanir (katalog agirlikla EN).
      cand(21, "Replacement Laces Kit for Running Shoes Spare Parts", 0.6),
      cand(22, "top up the balance payment link", 0.6),
      cand(23, "Hafif Kosu Ayakkabisi Nefes Alir", 0.6),
    ];
    const out = fuseForIndex(
      "conditional_hybrid",
      strongText,
      cands,
      "deri olmayan kosu ayakkabisi",
      textSim,
      LEXICON,
    );
    const ids = out.entries.map((e) => e.productId);
    expect(ids).not.toContain(20);
    expect(ids).not.toContain(22);
    expect(ids).not.toContain(21);
  });

  it("model kodu sorguda varsa baslikta olmayan anlamsal aday girmez", () => {
    const text = [item(1, "DDR5 32GB Bellek"), item(2, "DDR5 32GB RAM"), item(3, "DDR5 32GB Kit")];
    const cands = [
      cand(30, "DDR4 16GB Bellek Modulu Dizustu", 0.7),
      cand(31, "DDR5 32GB Bellek Soguticili", 0.69),
    ];
    const sim = new Map([
      [1, 0.6],
      [2, 0.6],
      [3, 0.6],
    ]);
    const out = fuseForIndex("conditional_hybrid", text, cands, "DDR5 32GB bellek", sim, LEXICON);
    const ids = out.entries.map((e) => e.productId);
    expect(ids).not.toContain(30);
  });

  it("anlamsal-yalniz urun sayisi politika tavanini asmaz", () => {
    const cands = Array.from({ length: 30 }, (_, i) =>
      cand(100 + i, `Kosu Ayakkabisi Model ${i} Hafif Yastikli`, 0.6 - i * 0.0001),
    );
    const out = fuseForIndex(
      "conditional_hybrid",
      strongText,
      cands,
      "kosu ayakkabisi",
      textSim,
      LEXICON,
    );
    expect(out.entries.filter((e) => e.source === "semantic").length).toBeLessThanOrEqual(
      BGE_M3_HYBRID_POLICY.maxSemanticOnly,
    );
  });

  it("anlamsal aday yoksa sonuc yalniz metin sonuclaridir (ayni siralama)", () => {
    const out = fuseForIndex(
      "conditional_hybrid",
      strongText,
      [],
      "kosu ayakkabisi",
      textSim,
      LEXICON,
    );
    expect(out.entries.map((e) => e.productId)).toEqual([1, 2, 3, 4]);
    expect(out.entries.every((e) => e.source === "text")).toBe(true);
  });

  it("zayif lexical (exact yok) -> blend; yine hicbir metin sonucu dusmez", () => {
    const weak = [item(1, "Ayakkabi A", "related"), item(2, "Ayakkabi B", "related")];
    const out = fuseForIndex(
      "conditional_hybrid",
      weak,
      [cand(5, "Kosu Ayakkabisi Hafif Yastikli", 0.6)],
      "kosu ayakkabisi",
      new Map(),
      LEXICON,
    );
    expect(out.mode).toBe("blend");
    const ids = out.entries.map((e) => e.productId);
    expect(ids).toEqual(expect.arrayContaining([1, 2]));
  });
});
