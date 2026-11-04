/**
 * Karsilastirma sorgu seti sagligi (plan T2): etiket kaynagi isaretli,
 * kategori-iliski tutarli, referans metni sorguda gecer, markalar setin
 * sozluk listesinde, IntentV2 dev setiyle asiri benzerlik yok.
 */
import { describe, expect, it } from "vitest";
import { COMPARISON_RELATIONS, type ComparisonDataset } from "./comparison-eval.ts";
import { findNearDuplicates, jaccard, tokens } from "./dataset-lint.ts";
import dataset from "./datasets/comparison-queries.dev.json" with { type: "json" };
import intentDev from "./datasets/intent-v2.dev.json" with { type: "json" };

const DEV = dataset as unknown as ComparisonDataset;
const lower = (text: string) => text.toLocaleLowerCase("tr");

describe("karsilastirma dev seti", () => {
  it("en az 40 vaka, benzersiz kimlik, her iliski ve kontrol temsil ediliyor", () => {
    expect(DEV.cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(DEV.cases.map((c) => c.id)).size).toBe(DEV.cases.length);
    for (const relation of COMPARISON_RELATIONS) {
      const n = DEV.cases.filter((c) => c.gold.relation === relation).length;
      expect(n, relation).toBeGreaterThanOrEqual(3);
    }
    expect(DEV.cases.filter((c) => c.cat === "control").length).toBeGreaterThanOrEqual(6);
  });

  it("etiket kaynagi acikca taslak isaretli (bagimsiz insan etiketi degil)", () => {
    expect(DEV.label_source).toBe("ai_drafted_pending_human_review");
  });

  it("kategori, iliski ve referans turu tutarli", () => {
    for (const c of DEV.cases) {
      if (c.cat === "control") {
        expect(c.gold.relation, c.id).toBeNull();
        expect(c.gold.anchor, c.id).toBeNull();
        expect(c.gold.anchor_brand, c.id).toBeNull();
        continue;
      }
      expect(c.gold.relation, c.id).not.toBeNull();
      expect(c.gold.brand_include, c.id).toEqual([]);
      if (c.cat === "context") {
        expect(c.gold.anchor?.kind, c.id).toBe("context");
      } else {
        expect(c.gold.relation, c.id).toBe(c.cat);
      }
      if (c.gold.anchor?.kind === "context") expect(c.gold.anchor.text, c.id).toBeNull();
      if (c.gold.relation === "different_brand") {
        expect(c.gold.exclude_brands.length, c.id).toBeGreaterThan(0);
      }
    }
  });

  it("referans metni ve markalar sorguda yazili; markalar sozluk listesinde", () => {
    const brands = new Set(DEV.lexicon_brands);
    for (const c of DEV.cases) {
      const q = lower(c.q);
      if (c.gold.anchor?.text) expect(q.includes(lower(c.gold.anchor.text)), c.id).toBe(true);
      const named = [
        ...(c.gold.anchor_brand ? [c.gold.anchor_brand] : []),
        ...c.gold.brand_include,
        ...c.gold.exclude_brands,
      ];
      for (const brand of named) {
        expect(brands.has(brand), `${c.id} ${brand}`).toBe(true);
        expect(q.includes(brand), `${c.id} ${brand}`).toBe(true);
      }
    }
  });

  it("asiri benzer sorgu yok; IntentV2 dev setiyle kesismiyor", () => {
    expect(findNearDuplicates(DEV.cases.map((c) => c.q))).toEqual([]);
    const intentTokens = (intentDev as { cases: { q: string }[] }).cases.map((c) => tokens(c.q));
    for (const c of DEV.cases) {
      const ct = tokens(c.q);
      for (const it of intentTokens) expect(jaccard(ct, it), c.id).toBeLessThan(0.9);
    }
  });
});
