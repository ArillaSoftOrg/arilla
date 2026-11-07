import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import type { QueryObject } from "../search/types.ts";
import type { RawIntentV2 } from "./contract.ts";
import { fromRawQuery } from "./normalized-query-adapter.ts";
import { applyIntentPlan, compatTier, toSearchPlan } from "./to-search.ts";
import { validateIntentV2 } from "./validate.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "brand", surface: "samsung", normalized: "samsung", weight: 1 },
  { kind: "brand", surface: "apple", normalized: "apple", weight: 1 },
  { kind: "brand", surface: "lenovo", normalized: "lenovo", weight: 1 },
  { kind: "brand", surface: "xiaomi", normalized: "xiaomi", weight: 1 },
];

function raw(overrides: Partial<RawIntentV2> = {}): RawIntentV2 {
  return {
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
    ...overrides,
  };
}

const plan = (q: string, r: RawIntentV2) =>
  toSearchPlan(validateIntentV2(r, { query: fromRawQuery(q), lexicon: LEXICON }));

function baseQuery(filters: QueryObject["filters"] = {}): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: "x",
    filters,
    style_tags: [],
    sort: "balanced",
    unparsed: "x",
    confidence: 0.5,
  };
}

describe("toSearchPlan: H -> filtre, R -> ipucu, D -> gosterim", () => {
  it("acik marka + acik butce -> filtre (kurus); dogrulanmamis tur kategorisi yalniz ipucu", () => {
    const p = plan(
      "lenovo laptop 30000 tl altı",
      raw({
        product_type: { text: "laptop", type_id: "laptop", evidence: "laptop" },
        role: "main",
        brand: { text: "Lenovo", evidence: "lenovo" },
        budget: { min_try: null, max_try: 30000 },
      }),
    );
    expect(p.filters.brand_include).toEqual(["lenovo"]);
    expect(p.filters.price_max).toBe(3_000_000);
    expect(p.filters.price_min).toBeUndefined();
    // laptop yolu uretimde dogrulanamadi (category-map): filtre yok, ipucu var.
    expect(p.filters.category_path).toBeUndefined();
    expect(p.hints.category).toBe("elektronik/bilgisayar-grubu");
  });

  it("uretimde dogrulanmis tur kategorisi (oyun konsolu) -> kategori filtresi", () => {
    const p = plan(
      "oyun konsolu",
      raw({
        product_type: { text: "oyun konsolu", type_id: "game_console", evidence: "oyun konsolu" },
        role: "main",
      }),
    );
    expect(p.filters.category_path).toBe("elektronik");
    expect(p.hints.category).toBeNull();
  });

  it("aksesuar sorgusunda tur kategorisi filtre de ipucu da olmaz", () => {
    const p = plan(
      "oyun konsolu kılıfı",
      raw({
        product_type: { text: "oyun konsolu", type_id: "game_console", evidence: "oyun konsolu" },
        role: "accessory",
      }),
    );
    expect(p.filters.category_path).toBeUndefined();
    expect(p.hints.category).toBeNull();
  });

  it("uyumlu cihazin markasi brand_include'a girmez; uyumluluk yalniz ipucu", () => {
    const p = plan(
      "Samsung telefonuma şarj aleti lazım",
      raw({
        product_type: { text: "şarj aleti", type_id: null, evidence: "şarj aleti" },
        role: "accessory",
        compatible_with: { text: "Samsung telefon", evidence: "Samsung telefonuma" },
        brand: { text: "Samsung", evidence: "Samsung" },
      }),
    );
    expect(p.filters).toEqual({});
    expect(p.hints.compatibleWith).toBe("samsung telefon");
    expect(p.hints.role).toBe("accessory");
    expect(p.display.some((c) => c.field === "brand")).toBe(true);
  });

  it("baslik tabanli oznitelikler (zorunlu/haric) asla filtre olmaz", () => {
    const p = plan(
      "kablosuz olmayan 144 hz monitör",
      raw({
        product_type: { text: "monitör", type_id: null, evidence: "monitör" },
        role: "main",
        attributes: [
          {
            key: "connectivity",
            value: "kablosuz",
            strength: "excluded",
            evidence: "kablosuz olmayan",
          },
          { key: "refresh_rate", value: "144 Hz", strength: "required", evidence: "144 hz" },
        ],
      }),
    );
    expect(p.filters).toEqual({});
    expect(p.hints.excluded).toContain("kablosuz");
    expect(p.hints.required).toContain("144 hz");
  });

  it("metinde olmayan (cikarilmis) marka filtre olmaz", () => {
    const p = plan(
      "iphone 15 kılıfı",
      raw({
        product_type: { text: "kılıf", type_id: null, evidence: "kılıfı" },
        role: "accessory",
        compatible_with: { text: "iphone 15", evidence: "iphone 15" },
        brand: { text: "Apple", evidence: null },
      }),
    );
    expect(p.filters.brand_include).toBeUndefined();
  });

  it("haric marka -> brand_exclude", () => {
    const p = plan(
      "xiaomi hariç akıllı saat",
      raw({
        product_type: { text: "akıllı saat", type_id: null, evidence: "akıllı saat" },
        role: "main",
        excluded_brands: [{ text: "Xiaomi", evidence: "xiaomi hariç" }],
      }),
    );
    expect(p.filters.brand_exclude).toEqual(["xiaomi"]);
    expect(p.filters.brand_include).toBeUndefined();
  });

  it("gecersiz cikti -> bos plan (deterministik aramaya dokunmaz)", () => {
    const p = toSearchPlan(
      validateIntentV2({ nope: 1 }, { query: fromRawQuery("x"), lexicon: LEXICON }),
    );
    expect(p.filters).toEqual({});
    expect(p.hints.required).toEqual([]);
  });
});

describe("applyIntentPlan: deterministik alan ezilmez", () => {
  it("bos alan doldurulur, dolu alan korunur, dislama birlesir", () => {
    const merged = applyIntentPlan(baseQuery({ price_max: 100_000, brand_exclude: ["apple"] }), {
      filters: { price_max: 999_999, brand_include: ["lenovo"], brand_exclude: ["xiaomi"] },
      hints: {
        role: null,
        category: null,
        compatibleWith: null,
        required: [],
        preferred: [],
        excluded: [],
        brands: [],
      },
      display: [],
    });
    expect(merged.filters.price_max).toBe(100_000);
    expect(merged.filters.brand_include).toEqual(["lenovo"]);
    expect(merged.filters.brand_exclude).toEqual(["apple", "xiaomi"]);
  });

  it("bos plan -> filtreler birebir ayni", () => {
    const base = baseQuery({ color: ["black"] });
    const merged = applyIntentPlan(base, {
      filters: {},
      hints: {
        role: null,
        category: null,
        compatibleWith: null,
        required: [],
        preferred: [],
        excluded: [],
        brands: [],
      },
      display: [],
    });
    expect(merged.filters).toEqual(base.filters);
  });
});

describe("compatTier: kademe, dislama yok (§4.3)", () => {
  it.each([
    ["iPhone 15 Şeffaf Kılıf", "iphone 15", 1],
    ["Silikon Telefon Kılıfı 2 Adet", "iphone 15", 2],
    ["iPhone 13 Deri Kılıf", "iphone 15", 3],
    ["Galaxy S24 Kılıf", "iphone 15", 3],
    ["USB-C Şarj Kablosu 1 m", "samsung telefon", 2],
  ] as const)("%s / %s -> %d", (title, compat, tier) => {
    expect(compatTier(title, compat)).toBe(tier);
  });
});
