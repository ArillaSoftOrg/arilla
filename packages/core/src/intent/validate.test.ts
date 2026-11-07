import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import type { RawIntentV2 } from "./contract.ts";
import {
  type CorrectionLike,
  fromRawQuery,
  type NormalizedQueryLike,
} from "./normalized-query-adapter.ts";
import { type Criterion, criteriaIn, validateIntentV2 } from "./validate.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "brand", surface: "samsung", normalized: "samsung", weight: 1 },
  { kind: "brand", surface: "apple", normalized: "apple", weight: 1 },
  { kind: "brand", surface: "logitech", normalized: "logitech", weight: 1 },
  { kind: "brand", surface: "lenovo", normalized: "lenovo", weight: 1 },
];

function base(overrides: Partial<RawIntentV2> = {}): RawIntentV2 {
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

function run(query: string | NormalizedQueryLike, raw: unknown) {
  const q = typeof query === "string" ? fromRawQuery(query) : query;
  return validateIntentV2(raw, { query: q, lexicon: LEXICON });
}

function find(criteria: Criterion[], field: Criterion["field"], value?: string) {
  return criteria.find((c) => c.field === field && (value === undefined || c.value === value));
}

describe("A. aksesuar niyeti: 'Samsung telefonuma şarj aleti lazım'", () => {
  const q = "Samsung telefonuma şarj aleti lazım";
  const result = run(
    q,
    base({
      product_type: { text: "şarj aleti", type_id: null, evidence: "şarj aleti" },
      role: "accessory",
      compatible_with: { text: "Samsung telefon", evidence: "Samsung telefonuma" },
      brand: { text: "Samsung", evidence: "Samsung" },
    }),
  );

  it("uyumlu cihazın markası sert filtre olmaz (yalnızca gösterim)", () => {
    const brand = find(result.criteria, "brand");
    expect(brand?.mode).toBe("D");
    expect(brand?.reason).toBe("brand_is_compatible_device");
  });

  it("uyumluluk yalnızca sıralama ipucudur; hiçbir şey sert filtre değil", () => {
    expect(find(result.criteria, "compatible_with")?.mode).toBe("R");
    expect(criteriaIn(result, "H")).toEqual([]);
  });

  it("uydurulmuş telefon modeli kanıtla çelişir ve atılır", () => {
    const hallucinated = run(
      q,
      base({
        product_type: { text: "şarj aleti", type_id: null, evidence: "şarj aleti" },
        role: "accessory",
        compatible_with: { text: "Samsung Galaxy S24", evidence: "Samsung telefonuma" },
      }),
    );
    expect(find(hallucinated.criteria, "compatible_with")?.mode).toBe("X");
  });
});

describe("B. teknik özellikler: '144 Hz, 27 inç, IPS oyuncu monitörü'", () => {
  const q = "144 Hz, 27 inç, IPS oyuncu monitörü";
  const result = run(
    q,
    base({
      product_type: { text: "oyuncu monitörü", type_id: "monitor", evidence: "oyuncu monitörü" },
      role: "main",
      attributes: [
        { key: "refresh_rate", value: "144 Hz", strength: "required", evidence: "144 Hz" },
        { key: "screen_size", value: "27 inç", strength: "required", evidence: "27 inç" },
        { key: "panel_type", value: "IPS", strength: "required", evidence: "IPS" },
      ],
    }),
  );

  it("monitör yolu üretimde doğrulanamadı: kategori yalnızca sıralama ipucu (R)", () => {
    expect(find(result.criteria, "category")?.mode).toBe("R");
    expect(find(result.criteria, "category")?.reason).toBe("category_not_verified");
    expect(find(result.criteria, "category")?.canonical).toBe("elektronik/bilgisayar-grubu");
  });

  it("başlığa dayanan teknik özellikler asla H olmaz", () => {
    const attrs = result.criteria.filter((c) => c.field === "attribute");
    expect(attrs).toHaveLength(3);
    for (const attr of attrs) expect(attr.mode).toBe("R");
  });

  it("kanıtta olmayan sayı (165 Hz) atılır", () => {
    const bad = run(
      q,
      base({
        product_type: { text: "monitör", type_id: "monitor", evidence: "monitörü" },
        attributes: [
          { key: "refresh_rate", value: "165 Hz", strength: "required", evidence: "144 Hz" },
        ],
      }),
    );
    expect(bad.criteria.find((c) => c.field === "attribute")?.mode).toBe("X");
  });
});

describe("C. bütçe: '3000 TL altında kablosuz kulaklık'", () => {
  const q = "3000 TL altında kablosuz kulaklık";

  it("metindeki tutar H olur, kuruşa çevrilir", () => {
    const result = run(
      q,
      base({
        product_type: { text: "kulaklık", type_id: null, evidence: "kulaklık" },
        role: "main",
        attributes: [
          { key: "connectivity", value: "kablosuz", strength: "required", evidence: "kablosuz" },
        ],
        budget: { min_try: null, max_try: 3000 },
      }),
    );
    expect(result.budget).toEqual({ minKurus: null, maxKurus: 300000 });
    expect(find(result.criteria, "budget")?.mode).toBe("H");
    expect(find(result.criteria, "attribute")?.mode).toBe("R");
  });

  it("bütçe değiştirilemez: metinde olmayan tutar atılır", () => {
    const result = run(q, base({ budget: { min_try: null, max_try: 3500 } }));
    expect(result.budget).toBeNull();
    expect(find(result.criteria, "budget")?.mode).toBe("X");
  });

  it("'çok pahalı olmasın' fiyat sınırı olmaz; yalnızca gösterim tercihi", () => {
    const vague = run(
      "çok pahalı olmasın kablosuz kulaklık",
      base({ budget: { min_try: null, max_try: 2000 }, price_preference: "lower" }),
    );
    expect(vague.budget).toBeNull();
    expect(find(vague.criteria, "price_preference")?.mode).toBe("D");
  });
});

describe("D. uyumluluk: 'iPhone 15 Pro Max için kılıf'", () => {
  const q = "iPhone 15 Pro Max için kılıf";
  const result = run(
    q,
    base({
      product_type: { text: "kılıf", type_id: null, evidence: "kılıf" },
      role: "accessory",
      compatible_with: { text: "iPhone 15 Pro Max", evidence: "iPhone 15 Pro Max" },
    }),
  );

  it("model uyumluluğu korunur ama dışlama yapmaz (R, yanlış negatif yok)", () => {
    const compat = find(result.criteria, "compatible_with");
    expect(compat?.value).toBe("iPhone 15 Pro Max");
    expect(compat?.mode).toBe("R");
    expect(criteriaIn(result, "H")).toEqual([]);
  });

  it("modelin uyumlu cihazı daraltması (15 -> 16) atılır", () => {
    const bad = run(
      q,
      base({
        product_type: { text: "kılıf", type_id: null, evidence: "kılıf" },
        compatible_with: { text: "iPhone 16 Pro Max", evidence: "iPhone 15 Pro Max" },
      }),
    );
    expect(find(bad.criteria, "compatible_with")?.mode).toBe("X");
  });
});

describe("E. olumsuz kriter: 'Kablosuz olmayan oyuncu faresi'", () => {
  const result = run(
    "Kablosuz olmayan oyuncu faresi",
    base({
      product_type: { text: "oyuncu faresi", type_id: null, evidence: "oyuncu faresi" },
      role: "main",
      attributes: [
        {
          key: "connectivity",
          value: "kablosuz",
          strength: "excluded",
          evidence: "Kablosuz olmayan",
        },
      ],
    }),
  );

  it("hariç tutulan özellik dışlama filtresi olmaz, yalnızca sıralama", () => {
    const excluded = result.criteria.find((c) => c.strength === "excluded");
    expect(excluded?.mode).toBe("R");
    expect(criteriaIn(result, "H")).toEqual([]);
  });

  it("karşıtı (kablolu) tablodan türetilir ve yalnızca tercih olur", () => {
    const derived = result.criteria.find((c) => c.strength === "derived_preferred");
    expect(derived?.canonical).toBe("wired");
    expect(derived?.mode).toBe("R");
    expect(derived?.source).toBe("derived");
  });

  it("kablosuz zorunlu tercih yapılmaz", () => {
    expect(
      result.criteria.some((c) => c.canonical === "wireless" && c.strength === "required"),
    ).toBe(false);
  });
});

describe("F. gündelik ifade: 'Üniversitede not tutmak için uygun fiyatlı tablet'", () => {
  const result = run(
    "Üniversitede not tutmak için uygun fiyatlı tablet",
    base({
      product_type: { text: "tablet", type_id: "tablet", evidence: "tablet" },
      role: "main",
      use_case: { text: "not tutmak", evidence: "not tutmak" },
      attributes: [
        { key: "feature", value: "kalem desteği", strength: "preferred", evidence: null },
      ],
      price_preference: "lower",
      brand: { text: "Lenovo", evidence: null },
    }),
  );

  it("kullanım amacından çıkarılan özellik ve fiyat tercihi yalnızca gösterim", () => {
    expect(find(result.criteria, "attribute")?.mode).toBe("D");
    expect(find(result.criteria, "use_case")?.mode).toBe("D");
    expect(find(result.criteria, "price_preference")?.mode).toBe("D");
    expect(result.budget).toBeNull();
  });

  it("kullanıcının yazmadığı marka filtre olmaz", () => {
    expect(find(result.criteria, "brand")?.mode).toBe("D");
    // Tablet kategorisi üretimde doğrulanamadı: hiçbir kesin filtre yok.
    expect(criteriaIn(result, "H")).toEqual([]);
  });
});

describe("G. belirsizlik: 'Samsung için hızlı şarj'", () => {
  it("tür anlaşıldıysa soru engelleyici değildir; arama yapılır", () => {
    const result = run(
      "Samsung için hızlı şarj",
      base({
        product_type: { text: "şarj cihazı", type_id: null, evidence: "hızlı şarj" },
        role: "accessory",
        compatible_with: { text: "Samsung", evidence: "Samsung" },
        ambiguous_fields: ["compatible_with", "connector"],
        clarification: { question: "Hangi bağlantı?", options: ["USB-C", "Kablosuz"] },
      }),
    );
    expect(result.clarification?.blocking).toBe(false);
    expect(result.ambiguous).toEqual(["compatible_with", "connector"]);
    expect(find(result.criteria, "brand")).toBeUndefined();
  });

  it("tür yoksa soru engelleyicidir", () => {
    const result = run(
      "samsung için bir şey",
      base({ clarification: { question: "Ne arıyorsun?", options: ["Şarj cihazı", "Kılıf"] } }),
    );
    expect(result.clarification?.blocking).toBe(true);
  });

  it("bağlantı içeren soru atılır", () => {
    const result = run(
      "samsung şarj",
      base({ clarification: { question: "Bak: https://x.com", options: ["a", "b"] } }),
    );
    expect(result.clarification).toBeNull();
  });
});

describe("istenmeyen marka", () => {
  it("açık + lexicon markası H (brand_exclude); lexicon dışı yalnızca R", () => {
    const result = run(
      "apple olmasın tablet, razer de olmasın",
      base({
        product_type: { text: "tablet", type_id: "tablet", evidence: "tablet" },
        excluded_brands: [
          { text: "Apple", evidence: "apple olmasın" },
          { text: "Razer", evidence: "razer" },
        ],
      }),
    );
    expect(find(result.criteria, "excluded_brand", "Apple")?.mode).toBe("H");
    expect(find(result.criteria, "excluded_brand", "Apple")?.canonical).toBe("apple");
    expect(find(result.criteria, "excluded_brand", "Razer")?.mode).toBe("R");
    expect(find(result.criteria, "brand")).toBeUndefined();
  });

  it("metinde olmayan istenmeyen marka filtre olmaz", () => {
    const result = run("tablet", base({ excluded_brands: [{ text: "Samsung", evidence: null }] }));
    expect(find(result.criteria, "excluded_brand")?.mode).toBe("D");
  });
});

describe("kip kuralları", () => {
  it("açık lexicon markası H; lexicon'da olmayan açık marka R", () => {
    const known = run(
      "logitech mouse",
      base({ brand: { text: "Logitech", evidence: "logitech" } }),
    );
    expect(find(known.criteria, "brand")?.mode).toBe("H");
    expect(find(known.criteria, "brand")?.canonical).toBe("logitech");
    const unknown = run("razer mouse", base({ brand: { text: "Razer", evidence: "razer" } }));
    expect(find(unknown.criteria, "brand")?.mode).toBe("R");
  });

  it("aksesuar rolünde ürün türünün kategorisi filtre olmaz", () => {
    const result = run(
      "laptop çantası",
      base({
        product_type: { text: "laptop çantası", type_id: "laptop", evidence: "laptop çantası" },
        role: "accessory",
      }),
    );
    expect(find(result.criteria, "category")?.mode).toBe("D");
    expect(find(result.criteria, "category")?.reason).toBe("type_not_main_role");
  });

  it("geçersiz rol tüm yorumu gösterime indirir", () => {
    const result = run(
      "logitech mouse 3000 tl altı",
      base({
        role: "bundle" as never,
        brand: { text: "Logitech", evidence: "logitech" },
        budget: { min_try: null, max_try: 3000 },
      }),
    );
    expect(result.downgraded).toBe(true);
    expect(criteriaIn(result, "H")).toEqual([]);
    expect(result.budget).toBeNull();
    expect(result.confidence).toBe("low");
  });

  it("şema sürümü 2 değilse hiçbir şey kabul edilmez", () => {
    const result = run("tablet", { ...base(), schema_version: 1 });
    expect(result.criteria).toEqual([]);
    expect(result.confidence).toBe("low");
  });

  it("bilinmeyen öznitelik anahtarı atılır", () => {
    const result = run(
      "tablet",
      base({
        attributes: [
          { key: "weight" as never, value: "1 kg", strength: "required", evidence: null },
        ],
      }),
    );
    expect(result.criteria[0]?.mode).toBe("X");
  });
});

describe("normalizasyon düzeltmeleri açık beyan sayılmaz (§6.3)", () => {
  function corrected(
    raw: string,
    fixed: string,
    correction: Partial<CorrectionLike>,
  ): NormalizedQueryLike {
    const q = fromRawQuery(raw);
    return {
      ...q,
      corrected: fixed,
      corrections: [
        {
          from: "samsng",
          to: "samsung",
          span: [0, 6],
          kind: "brand",
          confidence: 0.95,
          preservesCodes: true,
          ...correction,
        },
      ],
    };
  }

  it("güvenilir düzeltilmiş marka yalnızca R olur, asla H", () => {
    const q = corrected("samsng şarj aleti", "samsung şarj aleti", {});
    const result = run(q, base({ brand: { text: "Samsung", evidence: "samsung" } }));
    const brand = find(result.criteria, "brand");
    expect(brand?.source).toBe("corrected");
    expect(brand?.mode).toBe("R");
  });

  it("düşük güvenli düzeltme yalnızca gösterim", () => {
    const q = corrected("samsng şarj aleti", "samsung şarj aleti", { confidence: 0.5 });
    const result = run(q, base({ brand: { text: "Samsung", evidence: "samsung" } }));
    expect(find(result.criteria, "brand")?.mode).toBe("D");
  });

  it("model kodunu değiştiren düzeltme reddedilir (s24 -> s23)", () => {
    const raw = "samsung s24 kılıf";
    const q: NormalizedQueryLike = {
      ...fromRawQuery(raw),
      corrected: "samsung s23 kılıf",
      corrections: [
        {
          from: "s24",
          to: "s23",
          span: [8, 11],
          kind: "model",
          confidence: 0.99,
          preservesCodes: true,
        },
      ],
    };
    const result = run(
      q,
      base({ compatible_with: { text: "Samsung S23", evidence: "samsung s23" } }),
    );
    // Kanıt "s23" yalnızca düzeltilmiş metinde; düzeltme kod değiştirdiği için reddedilir.
    const compat = find(result.criteria, "compatible_with");
    expect(compat?.mode).not.toBe("R");
    expect(compat?.mode).not.toBe("H");
  });

  it("ham metindeki aralıkla örtüşmeyen düzeltme reddedilir", () => {
    const q = corrected("samsng şarj aleti", "samsung şarj aleti", { span: [3, 9] });
    const result = run(q, base({ brand: { text: "Samsung", evidence: "samsung" } }));
    expect(find(result.criteria, "brand")?.mode).toBe("D");
  });
});
