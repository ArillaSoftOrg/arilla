import { describe, expect, it } from "vitest";
import { step } from "./engine.ts";
import {
  applyInterpretation,
  buildInterpreterJsonSchema,
  describeTaxonomy,
  type IntentInterpreter,
  validateInterpretation,
} from "./interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "./rules.ts";
import { applyInput, createInitialState } from "./state.ts";
import { TEST_CONTEXT } from "./test-fixtures.ts";

const registry = DEFAULT_CLARIFICATION_REGISTRY;

describe("cikti semasi", () => {
  const schema = buildInterpreterJsonSchema(registry) as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<
      string,
      { enum?: unknown[]; items?: { anyOf: { properties: Record<string, { enum: string[] }> }[] } }
    >;
  };

  it("katı: ek alan yok, tum alanlar zorunlu", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(["budget", "domain_id", "facets", "price_preference"]);
  });

  it("urun, fiyat, marka, stok alani icermez", () => {
    const keys = Object.keys(schema.properties);
    for (const forbidden of ["products", "price", "brand", "in_stock", "merchant", "title"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("secenek kimlikleri yalnizca taksonomiden gelir", () => {
    const variants = schema.properties.facets?.items?.anyOf ?? [];
    const helmet = variants.find((v) => v.properties.facet_id?.enum[0] === "helmet_type");
    expect(helmet?.properties.option_id?.enum).toEqual([
      "full_face",
      "open_face",
      "half",
      "modular",
      "off_road",
    ]);
    expect(schema.properties.domain_id?.enum).toContain(null);
  });

  it("taksonomi ozeti modele yalnizca kimlik ve etiket verir", () => {
    const taxonomy = describeTaxonomy(registry);
    const helmet = taxonomy.domains.find((d) => d.id === "helmet");
    expect(helmet?.facets[0]?.options[0]).toEqual({ id: "full_face", label: "Kapalı (full face)" });
  });
});

describe("dogrulama", () => {
  const helmetState = step(
    createInitialState(),
    { type: "text", text: "kask" },
    TEST_CONTEXT,
  ).state;

  it("uydurulmus secenek reddedilir", () => {
    const { value, rejected } = validateInterpretation(
      {
        domain_id: "helmet",
        facets: [{ facet_id: "helmet_type", option_id: "carbon_fiber" }],
        budget: null,
        price_preference: null,
      },
      { text: "karbon kask", state: helmetState },
      registry,
    );
    expect(value.facets).toEqual([]);
    expect(rejected).toEqual([{ path: "facets[0]", reason: "unknown_option" }]);
  });

  it("desteklenmeyen faset ve domain reddedilir", () => {
    const { value, rejected } = validateInterpretation(
      {
        domain_id: "yacht",
        facets: [
          { facet_id: "visor_tint", option_id: "dark" },
          { facet_id: "recipient", option_id: "mother" },
        ],
        budget: null,
        price_preference: null,
      },
      { text: "kask", state: helmetState },
      registry,
    );
    expect(value.domainId).toBeNull();
    expect(rejected.map((r) => r.reason)).toEqual([
      "unknown_domain",
      "unknown_facet",
      "facet_outside_domain",
    ]);
  });

  it("metinde olmayan butce sayisi reddedilir", () => {
    const { value, rejected } = validateInterpretation(
      {
        domain_id: null,
        facets: [],
        budget: { min_try: null, max_try: 3000 },
        price_preference: "lower",
      },
      { text: "uygun fiyatlı kask", state: helmetState },
      registry,
    );
    expect(value.budget).toBeNull();
    expect(rejected).toEqual([{ path: "budget", reason: "budget_not_in_text" }]);
    expect(value.pricePreference).toBe("lower");
  });

  it("metinde yazan butce kabul edilir ve kurusa cevrilir", () => {
    const { value } = validateInterpretation(
      {
        domain_id: null,
        facets: [],
        budget: { min_try: null, max_try: 3000 },
        price_preference: null,
      },
      { text: "3.000 tl civarı kask", state: helmetState },
      registry,
    );
    expect(value.budget).toEqual({ minKurus: null, maxKurus: 300000 });
  });

  it("nesne olmayan cikti tamamen reddedilir", () => {
    expect(
      validateInterpretation("helmet", { text: "", state: helmetState }, registry).rejected,
    ).toEqual([{ path: "$", reason: "not_an_object" }]);
  });
});

describe("oncelik", () => {
  it("model cikarimi acik kullanici cevabini ezemez", () => {
    let state = step(createInitialState(), { type: "text", text: "kask" }, TEST_CONTEXT).state;
    state = applyInput(
      state,
      { type: "answer", questionId: "helmet_type", optionId: "full_face" },
      TEST_CONTEXT,
    );
    const next = applyInterpretation(
      { ...state, turn: state.turn + 5 },
      {
        domainId: "helmet",
        facets: [{ facetId: "helmet_type", optionId: "open_face" }],
        budget: null,
        pricePreference: null,
      },
    );
    expect(next.facets.helmet_type).toMatchObject({ optionId: "full_face", source: "explicit" });
  });

  it("sonraki acik cevap model cikarimini ezer", () => {
    const base = step(createInitialState(), { type: "text", text: "kask" }, TEST_CONTEXT).state;
    const withModel = applyInterpretation(base, {
      domainId: null,
      facets: [{ facetId: "helmet_type", optionId: "modular" }],
      budget: null,
      pricePreference: null,
    });
    expect(withModel.facets.helmet_type?.source).toBe("model");
    const answered = applyInput(
      withModel,
      { type: "answer", questionId: "helmet_type", optionId: "half" },
      TEST_CONTEXT,
    );
    expect(answered.facets.helmet_type).toMatchObject({ optionId: "half", source: "explicit" });
  });

  it("model domain'i yalnizca bos domain'e yazilir", () => {
    const helmet = step(createInitialState(), { type: "text", text: "kask" }, TEST_CONTEXT).state;
    const next = applyInterpretation(helmet, {
      domainId: "gift",
      facets: [],
      budget: null,
      pricePreference: null,
    });
    expect(next.domainId).toBe("helmet");
    expect(next.domainSource).toBe("explicit");
  });

  it("atlanan soruya model deger yazamaz", () => {
    let state = step(createInitialState(), { type: "text", text: "kask" }, TEST_CONTEXT).state;
    state = applyInput(state, { type: "skip", questionId: "helmet_type" }, TEST_CONTEXT);
    const next = applyInterpretation(state, {
      domainId: null,
      facets: [{ facetId: "helmet_type", optionId: "modular" }],
      budget: null,
      pricePreference: null,
    });
    expect(next.facets.helmet_type).toBeUndefined();
  });
});

describe("saglayici-bagimsiz arayuz", () => {
  it("sahte bir yorumlayici uctan uca dogrulamadan gecer", async () => {
    const fake: IntentInterpreter = {
      interpret: async () => ({
        domain_id: "helmet",
        facets: [{ facet_id: "helmet_type", option_id: "full_face" }],
        budget: null,
        price_preference: null,
      }),
    };
    const state = createInitialState();
    const request = {
      text: "yüzümü tamamen kapatan bir şey",
      state,
      taxonomy: describeTaxonomy(registry),
    };
    const { value, rejected } = validateInterpretation(
      await fake.interpret(request),
      request,
      registry,
    );
    expect(rejected).toEqual([]);
    const next = applyInterpretation(state, value);
    expect(next.domainId).toBe("helmet");
    expect(next.domainSource).toBe("model");
    expect(next.facets.helmet_type?.source).toBe("model");
  });
});
