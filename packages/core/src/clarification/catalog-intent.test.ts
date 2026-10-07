/**
 * Karar 0063: Türkçe fiyat dili, katalog ürün türleri, desteklenen/desteksiz
 * niyet ve yapay zekâ özeti. Saf; veritabanı ve model yok.
 */
import { describe, expect, it } from "vitest";
import { planConversation } from "../conversational-search/plan.ts";
import { parseQueryText } from "../search/parse-query.ts";
import { textSlotsOf } from "../search/search-sql.ts";
import { buildSearchSummary, detectUnsupportedIntents } from "../search/search-summary.ts";
import { extractFacts } from "./extract.ts";
import { type ValidatedInterpretation, validateInterpretation } from "./interpreter.ts";
import { priceAmountsInText } from "./price-language.ts";
import { CATALOG_PRODUCT_TYPES } from "./product-types.ts";
import { validateRegistry } from "./registry.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "./rules.ts";
import { createInitialState } from "./state.ts";
import { TEST_CONTEXT } from "./test-fixtures.ts";

const context = { registry: DEFAULT_CLARIFICATION_REGISTRY, lexicon: [] };

/** Üretim kategori ağacı: migration 0016 + `saglik-kozmetik/kozmetik` (toplama kategori açmaz). */
const PRODUCTION_CATEGORY_PATHS = new Set([
  "elektronik",
  "ev-yasam",
  "anne-bebek",
  "kitap-muzik-hobi",
  "spor-outdoor",
  "oto-bahce",
  "petshop",
  "supermarket",
  "saglik-kozmetik",
  "saglik-kozmetik/kozmetik",
]);

describe("Türkçe fiyat dili (deterministik)", () => {
  it.each([
    ["10 bine kadar", null, 1_000_000],
    ["10 bin tl", null, 1_000_000],
    ["5-10 bin arası", 500_000, 1_000_000],
    ["5 ile 10 bin arası", 500_000, 1_000_000],
    ["2,5-4 bin tl", 250_000, 400_000],
    ["yaklaşık 20 bin", 1_600_000, 2_400_000],
    ["takriben 5000 tl", 400_000, 600_000],
  ])("%s", (text, minKurus, maxKurus) => {
    expect(extractFacts(text, TEST_CONTEXT).budget).toEqual({ minKurus, maxKurus });
  });

  it("çıplak '10 bin' deterministik bütçe sayılmaz (mevcut kural korunur)", () => {
    expect(extractFacts("10 bin", TEST_CONTEXT).budget).toBeNull();
  });

  it("ters aralık tahmin edilmez", () => {
    expect(extractFacts("2500-10 bin arası", TEST_CONTEXT).budget).not.toEqual({
      minKurus: 250_000_000,
      maxKurus: 1_000_000,
    });
  });

  it("konvansiyonel arama da '10 bin liraya kadar'ı süzgece çevirir, metne sızdırmaz", () => {
    const query = parseQueryText("10 bin liraya kadar laptop", []);
    expect(query.filters.price_max).toBe(1_000_000);
    expect(query.unparsed).not.toMatch(/\b(10|bin|liraya|kadar)\b/);
  });
});

describe("modelin bütçesi yalnızca metnin söylediği tutar olabilir", () => {
  it("metindeki tutarlar: rakam, 'bin' ve binli aralığın iki ucu", () => {
    expect([...priceAmountsInText("10 bin liraya kadar laptop")]).toContain(10_000);
    expect([...priceAmountsInText("5-10 bin arası")].sort()).toEqual(
      expect.arrayContaining([5_000, 10_000]),
    );
    expect([...priceAmountsInText("2,5 bin")]).toContain(2_500);
    expect(priceAmountsInText("iphone 16 kılıf").has(16_000)).toBe(false);
  });

  const request = (text: string) => ({ text, state: createInitialState() });
  const raw = (max: number) => ({
    domain_id: "laptop",
    facets: [],
    budget: { min_try: null, max_try: max },
    price_preference: null,
  });

  it("'10 bin' için 10000 kabul, 15000 reddedilir", () => {
    const ok = validateInterpretation(
      raw(10_000),
      request("10 bin liraya kadar oyun için hafif laptop"),
      DEFAULT_CLARIFICATION_REGISTRY,
    );
    expect(ok.rejected).toEqual([]);
    expect(ok.value.budget).toEqual({ minKurus: null, maxKurus: 1_000_000 });
    const bad = validateInterpretation(
      raw(15_000),
      request("10 bin liraya kadar oyun için hafif laptop"),
      DEFAULT_CLARIFICATION_REGISTRY,
    );
    expect(bad.rejected).toEqual([{ path: "budget", reason: "budget_not_in_text" }]);
  });
});

describe("katalog ürün türleri", () => {
  it("kayıt doğrulamasından geçer; her tür üretimde var olan kategoriye bağlı", () => {
    // Yalnizca katalog urun turleri: hediye domain'inin "moda" katkisi uretim
    // agacinda yok (onceden var olan, ayrica raporlanan bulgu).
    const productTypeIssues = validateRegistry(
      DEFAULT_CLARIFICATION_REGISTRY,
      PRODUCTION_CATEGORY_PATHS,
    ).filter((issue) =>
      CATALOG_PRODUCT_TYPES.some((type) => issue.path.startsWith(`domains.${type.id}`)),
    );
    expect(productTypeIssues).toEqual([]);
    for (const type of CATALOG_PRODUCT_TYPES) {
      expect(PRODUCTION_CATEGORY_PATHS.has(type.categoryPath), type.id).toBe(true);
    }
  });

  it("deterministik davranış değişmez: tür yalnızca modelle seçilir, mevcut altı domain aynı", () => {
    for (const domain of DEFAULT_CLARIFICATION_REGISTRY.domains.slice(6)) {
      expect(domain.modelOnly).toBe(true);
      expect(domain.triggers).toEqual([]);
    }
    expect(DEFAULT_CLARIFICATION_REGISTRY.domains.slice(0, 6).map((d) => d.id)).toEqual([
      "helmet",
      "shoes",
      "gift",
      "phone",
      "electronics",
      "home",
    ]);
    expect(
      planConversation({ query: "oyun için laptop", steps: [], reply: null }, context).mode,
    ).toBe("conventional");
  });
});

describe("laptop yorumu gerçek aramayı değiştirir; desteksiz niyet sahte süzgeç üretmez", () => {
  const query = "10 bin liraya kadar oyun için hafif laptop";
  const interpretation: ValidatedInterpretation = {
    domainId: "laptop",
    facets: [{ facetId: "laptop_qualifier", optionId: "gaming" }],
    budget: { minKurus: null, maxKurus: 1_000_000 },
    pricePreference: null,
  };

  it("kategori, fiyat ve başlık niteleyicisi; 'hafif' hiçbir yere girmez", () => {
    const plan = planConversation(
      { query, steps: [], reply: null },
      context,
      {},
      {
        firstTurnInterpretation: interpretation,
        firstTurnEnrichment: true,
      },
    );
    if (plan.mode !== "conversation") throw new Error("plan");
    expect(plan.action).toBe("search");
    expect(plan.queryObject.filters).toEqual({ category_path: "elektronik", price_max: 1_000_000 });
    expect(textSlotsOf(plan.queryObject)).toEqual([["gaming"], ["laptop", "notebook", "dizustu"]]);
    // `text` ham sorgudur (suzgec degil); suzgec, kapi ve unparsed'ta yok.
    const applied = JSON.stringify({
      filters: plan.queryObject.filters,
      slots: textSlotsOf(plan.queryObject),
      unparsed: plan.queryObject.unparsed,
    });
    expect(applied).not.toMatch(/hafif|agirlik|weight/);
  });

  it("desteksiz niyetler ayrıca raporlanır", () => {
    expect(detectUnsupportedIntents(query)).toEqual(["hafiflik"]);
    expect(detectUnsupportedIntents("16 gb ram 15.6 inç laptop pil ömrü uzun")).toEqual([
      "RAM ve depolama",
      "ekran boyutu",
      "pil ömrü",
    ]);
    expect(detectUnsupportedIntents("oyun için laptop")).toEqual([]);
  });
});

describe("yapay zekâ özeti", () => {
  const intent = {
    typeLabel: "Laptop / dizüstü bilgisayar",
    budget: { minKurus: null, maxKurus: 1_000_000 },
    constraintLabels: ["Oyun (gaming)"],
    unsupported: ["hafiflik"],
  };

  it("en fazla iki cümle; yalnızca yorum ve sonuç sayısı", () => {
    const text = buildSearchSummary(intent, { resultCount: 12, usedFallback: false });
    expect(text).toBe(
      "Aramanı “Laptop / dizüstü bilgisayar · En fazla 10.000 TL · Oyun (gaming)” olarak yorumladım. 12 ürün buldum; hafiflik bilgisi katalogda olmadığı için buna göre süzemedim.",
    );
    expect(text?.split(". ").length).toBeLessThanOrEqual(2);
  });

  it("sonuç yoksa yakın sonuçları söyler; yorum boşsa özet yok", () => {
    expect(buildSearchSummary(intent, { resultCount: 0, usedFallback: true })).toContain(
      "Tam eşleşen ürün bulamadım",
    );
    expect(
      buildSearchSummary(
        { typeLabel: null, budget: null, constraintLabels: [], unsupported: ["hafiflik"] },
        { resultCount: 5, usedFallback: false },
      ),
    ).toBeNull();
  });
});
