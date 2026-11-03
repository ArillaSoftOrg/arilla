import { describe, expect, it } from "vitest";
import { fromRawQuery } from "../intent/normalized-query-adapter.ts";
import { validateIntentV2 } from "../intent/validate.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import dev from "./datasets/intent-v2.dev.json" with { type: "json" };
import {
  brandEntries,
  type IntentV2Case,
  type IntentV2Dataset,
  predictFromLocal,
  predictFromValidated,
  scoreCase,
} from "./intent-v2-eval.ts";

const DEV = dev as unknown as IntentV2Dataset;
const LEXICON: LexiconEntry[] = brandEntries(DEV.lexicon_brands ?? []);
const byId = (id: string) => DEV.cases.find((c) => c.id === id) as IntentV2Case;

function scoreModel(id: string, raw: unknown) {
  const testCase = byId(id);
  const validated = validateIntentV2(raw, { query: fromRawQuery(testCase.q), lexicon: LEXICON });
  return scoreCase(testCase, predictFromValidated(validated));
}

const empty = {
  schema_version: 2,
  product_type: null,
  role: null,
  compatible_with: null,
  brand: null,
  excluded_brands: [],
  attributes: [],
  budget: null,
  price_preference: null,
  use_case: null,
  ambiguous_fields: [],
  clarification: null,
};

describe("puanlayıcı: doğru model çıktısı tam puan alır", () => {
  it("c02 uyumlu cihaz markası filtre olmaz, niyet korunur", () => {
    const row = scoreModel("c02", {
      ...empty,
      product_type: { text: "şarj aleti", type_id: null, evidence: "şarj aleti" },
      role: "accessory",
      compatible_with: { text: "Samsung telefon", evidence: "Samsung telefonuma" },
      brand: { text: "Samsung", evidence: "Samsung" },
    });
    expect(row.falseHard).toEqual([]);
    expect(row.preserved).toBe(true);
    expect(row.brand).toBe(true);
    expect(row.role).toBe(true);
  });

  it("n01 olumsuz kriter tersine dönmez", () => {
    const row = scoreModel("n01", {
      ...empty,
      product_type: { text: "oyuncu faresi", type_id: null, evidence: "oyuncu faresi" },
      role: "main",
      attributes: [
        {
          key: "connectivity",
          value: "kablosuz",
          strength: "excluded",
          evidence: "kablosuz olmayan",
        },
        { key: "feature", value: "oyuncu", strength: "required", evidence: "oyuncu" },
      ],
    });
    expect(row.reversed).toEqual([]);
    expect(row.preserved).toBe(true);
  });

  it("b01 bütçe tam eşleşir ve doğru sert filtredir", () => {
    const row = scoreModel("b01", {
      ...empty,
      product_type: { text: "kulaklık", type_id: null, evidence: "kulaklık" },
      role: "main",
      attributes: [
        { key: "connectivity", value: "kablosuz", strength: "required", evidence: "kablosuz" },
      ],
      budget: { min_try: null, max_try: 3000 },
    });
    expect(row.budget).toBe(true);
    expect(row.falseHard).toEqual([]);
    expect(row.preserved).toBe(true);
  });

  it("c01 uyumluluk varyantı kaybolursa (Pro Max -> 15) korunmamış sayılır", () => {
    const row = scoreModel("c01", {
      ...empty,
      product_type: { text: "kılıf", type_id: null, evidence: "kılıf" },
      role: "accessory",
      compatible_with: { text: "iPhone 15", evidence: "iPhone 15" },
    });
    expect(row.compat).toBe(false);
    expect(row.missing).toContain("compat");
  });
});

describe("puanlayıcı: bugünkü yerel yolun bilinen hataları görünür", () => {
  it("c02 Samsung ürün markası filtresi yanlış sert filtre ve ters niyettir", () => {
    const row = scoreCase(byId("c02"), predictFromLocal(byId("c02").q, LEXICON));
    expect(row.falseHard).toContain("brand:samsung");
    expect(row.reversed).toContain("compat_brand_as_product_brand");
  });

  it("n01 'kablosuz olmayan' zorunlu 'kablosuz' tokenına döner", () => {
    const row = scoreCase(byId("n01"), predictFromLocal(byId("n01").q, LEXICON));
    expect(row.reversed).toContain("attr:kablosuz");
  });
});
