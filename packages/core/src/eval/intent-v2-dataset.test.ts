/**
 * IntentV2 veri seti sagligi (karar 0171 §10): dev ve holdout ayrik, etiket
 * kaynagi isaretli, altin degerler katalog kurallariyla tutarli.
 */
import { describe, expect, it } from "vitest";
import { priceAmountsInText } from "../clarification/price-language.ts";
import { CATALOG_PRODUCT_TYPES } from "../clarification/product-types.ts";
import { ATTRIBUTE_KEYS } from "../intent/contract.ts";
import { findNearDuplicates, jaccard, tokens } from "./dataset-lint.ts";
import dev from "./datasets/intent-v2.dev.json" with { type: "json" };
import holdout from "./datasets/intent-v2.holdout.json" with { type: "json" };
import type { IntentV2Dataset } from "./intent-v2-eval.ts";

const DEV = dev as unknown as IntentV2Dataset;
const HOLDOUT = holdout as unknown as IntentV2Dataset;

const PLANNED: Record<string, number> = {
  simple: 12,
  multi: 12,
  ambiguous: 10,
  budget: 10,
  compat: 10,
  part: 10,
  negative: 8,
  tech: 10,
  use_case: 8,
  english: 10,
};

describe("dev seti", () => {
  it("100 vaka, benzersiz kimlik, planlanan kategori dagilimi", () => {
    expect(DEV.cases).toHaveLength(100);
    expect(new Set(DEV.cases.map((c) => c.id)).size).toBe(100);
    const counts: Record<string, number> = {};
    for (const c of DEV.cases) counts[c.cat] = (counts[c.cat] ?? 0) + 1;
    expect(counts).toEqual(PLANNED);
  });

  it("yaklasik %20 yazim hatasi", () => {
    const typos = DEV.cases.filter((c) => c.typo).length;
    expect(typos).toBeGreaterThanOrEqual(15);
    expect(typos).toBeLessThanOrEqual(25);
  });

  it("etiket kaynagi acikca taslak isaretli (bagimsiz insan etiketi degil)", () => {
    expect(DEV.label_source).toBe("ai_drafted_pending_human_review");
  });

  it("asiri benzer sorgu yok", () => {
    expect(findNearDuplicates(DEV.cases.map((c) => c.q))).toEqual([]);
  });

  it("type_id katalogda var ve kategori yolu eslesiyor", () => {
    for (const c of DEV.cases) {
      if (c.gold.type_id === null) {
        expect(c.gold.category, c.id).toBeNull();
        continue;
      }
      const type = CATALOG_PRODUCT_TYPES.find((t) => t.id === c.gold.type_id);
      expect(type, c.id).toBeDefined();
      expect(c.gold.category, c.id).toBe(type?.categoryPath);
      expect(c.gold.role, c.id).toBe("main");
    }
  });

  it("markalar setin sozluk listesinde; butce tutarlari metinde yazili", () => {
    const brands = new Set(DEV.lexicon_brands);
    for (const c of DEV.cases) {
      if (c.gold.brand) expect(brands.has(c.gold.brand), c.id).toBe(true);
      for (const b of c.gold.exclude_brands) expect(brands.has(b), c.id).toBe(true);
      if (c.gold.budget) {
        const allowed = priceAmountsInText(c.q);
        for (const amount of c.gold.budget) {
          if (amount !== null) expect(allowed.has(amount), `${c.id} ${amount}`).toBe(true);
        }
      }
    }
  });

  it("oznitelik anahtarlari sozlesmede", () => {
    for (const c of DEV.cases) {
      for (const [key] of c.gold.attrs) {
        expect((ATTRIBUTE_KEYS as readonly string[]).includes(key), `${c.id} ${key}`).toBe(true);
      }
    }
  });
});

describe("holdout", () => {
  it("dev ile kesisim ve 0.9 ustu benzerlik yok", () => {
    const devTokens = DEV.cases.map((c) => tokens(c.q));
    for (const h of HOLDOUT.cases) {
      const ht = tokens(h.q);
      for (const [i, dt] of devTokens.entries()) {
        expect(jaccard(ht, dt), `${h.id} ~ ${DEV.cases[i]?.id}`).toBeLessThan(0.9);
      }
    }
  });

  it("bagimsiz insan etiketi olarak isaretli; Claude doldurmaz", () => {
    expect(HOLDOUT.label_source).toBe("human_independent");
  });
});
