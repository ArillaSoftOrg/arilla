/**
 * Karar 0199: konu iliskisi (`relation`) ve acik tasima (`carry`).
 * `hardening.test.ts` (karar 0074 davranisi) DEGISMEZ; burasi yeni sozlesmeyi ayri dogrular.
 */
import { describe, expect, it } from "vitest";
import {
  CARRY_FILTERS_VALUE,
  FRESH_SEARCH_VALUE,
  type ModelTurn,
  parseModelTurn,
  type SearchIntent,
  type SearchIntentPatch,
} from "./contract.ts";
import {
  effectiveRelation,
  emptyIntent,
  mergeSearchIntent,
  previousTopicIntents,
} from "./intent.ts";
import {
  buildChatInput,
  CHAT_INSTRUCTIONS,
  fallbackTurn,
  fallbackTurnAfterNewTopic,
  groundPatch,
  type InterpretRequest,
  interpretTurn,
  neutralizeCompatibilityClaim,
} from "./interpreter.ts";

const patch = (p: Partial<SearchIntentPatch> = {}): SearchIntentPatch => ({
  reset: false,
  clear: false,
  remove: [],
  ...p,
});

const text = (value: string): Pick<InterpretRequest, "messages" | "input"> => ({
  messages: [{ role: "user", kind: "text", text: value }],
  input: { kind: "text", text: value },
});

const req = (value: string, currentIntent: SearchIntent | null): InterpretRequest => ({
  ...text(value),
  currentIntent,
  pendingQuestion: null,
  clarifyCount: 0,
});

const NIKE_SHOES: SearchIntent = {
  ...emptyIntent("nike ayakkabı"),
  category: "ayakkabı",
  brand: "Nike",
  colors: ["siyah"],
  size: "42",
  priceMax: 5000,
  attributes: { usage: "günlük" },
};
const SAMSUNG_PHONE: SearchIntent = {
  ...emptyIntent("samsung telefon"),
  category: "telefon",
  brand: "Samsung",
  priceMax: 15000,
  sort: "cheapest",
};
const IPHONE: SearchIntent = {
  ...emptyIntent("iphone 15"),
  category: "telefon",
  brand: "Apple",
  priceMax: 60000,
  attributes: { storage: "256 GB" },
};

const BLACK: SearchIntent = {
  ...emptyIntent("siyah ayakkabı"),
  category: "ayakkabı",
  colors: ["siyah"],
  priceMax: 3000,
};
const BUDGET: SearchIntent = { ...emptyIntent("ayakkabı"), category: "ayakkabı", priceMax: 5000 };

/** Modelin dondurdugu yama -> dogrulama (groundPatch) -> birlestirme: gercek turn hatti. */
function run(current: SearchIntent | null, userText: string, p: Partial<SearchIntentPatch>) {
  const grounded = groundPatch(patch(p), req(userText, current));
  return { grounded, merged: mergeSearchIntent(current, grounded) };
}

describe("effectiveRelation keeps the decision-0074 contract when relation is absent", () => {
  it("legacy: reset = independent, otherwise refine", () => {
    expect(effectiveRelation(patch())).toBe("refine");
    expect(effectiveRelation(patch({ reset: true }))).toBe("new_independent");
  });
  it("explicit relation wins; new_related is not turned independent by reset", () => {
    expect(effectiveRelation(patch({ relation: "new_independent" }))).toBe("new_independent");
    expect(effectiveRelation(patch({ relation: "new_related", reset: true }))).toBe("new_related");
  });
  it("legacy category change without relation still keeps brand/color/price (0074)", () => {
    expect(mergeSearchIntent(NIKE_SHOES, patch({ category: "mont" }))).toMatchObject({
      brand: "Nike",
      colors: ["siyah"],
      priceMax: 5000,
      size: null,
      attributes: {},
    });
  });
});

describe("scenario matrix (model path: groundPatch + merge)", () => {
  it("Nike ayakkabı -> mont: with relation=new_related and no carry nothing is auto-carried", () => {
    const { merged } = run(NIKE_SHOES, "mont", {
      relation: "new_related",
      query: "mont",
      category: "mont",
    });
    expect(merged).toEqual({ ...emptyIntent("mont"), category: "mont" });
  });

  it("Nike ayakkabı -> 'Nike mont': the brand is an explicit new value", () => {
    const { merged } = run(NIKE_SHOES, "nike mont", {
      relation: "new_related",
      query: "nike mont",
      category: "mont",
      brand: "Nike",
    });
    expect(merged).toMatchObject({ query: "nike mont", brand: "Nike", priceMax: null, colors: [] });
  });

  it("Samsung telefon 15.000 TL -> masa lambası: brand, price and sort are not carried", () => {
    const { merged } = run(SAMSUNG_PHONE, "masa lambası", {
      relation: "new_independent",
      query: "masa lambası",
    });
    expect(merged).toEqual(emptyIntent("masa lambası"));
  });

  it("siyah ayakkabı -> 'siyah mont da göster': the explicit color is applied", () => {
    const { merged } = run({ ...NIKE_SHOES, brand: null }, "siyah mont da göster", {
      relation: "new_related",
      query: "siyah mont",
      category: "mont",
      colors: ["siyah"],
    });
    expect(merged).toMatchObject({ query: "siyah mont", colors: ["siyah"], priceMax: null });
  });

  it("5.000 TL altında ayakkabı -> 'aynı bütçeyle mont': price carries only because the user said so", () => {
    const { grounded, merged } = run(NIKE_SHOES, "aynı bütçeyle mont", {
      relation: "new_related",
      query: "mont",
      carry: ["priceMax", "brand"],
    });
    // marka metinde yok: model carry dese de tasinmaz
    expect(grounded.carry).toEqual(["priceMax"]);
    expect(merged).toMatchObject({ query: "mont", priceMax: 5000, brand: null, colors: [] });
  });

  it("model-proposed carry without user support is dropped (server verifies)", () => {
    const { grounded, merged } = run(NIKE_SHOES, "mont", {
      relation: "new_related",
      query: "mont",
      carry: ["priceMax", "brand", "colors"],
    });
    expect(grounded.carry).toBeUndefined();
    expect(merged).toEqual(emptyIntent("mont"));
  });

  it("carry can only name fields that are filled in the current intent", () => {
    const { grounded } = run({ ...NIKE_SHOES, priceMax: null }, "aynı bütçeyle mont", {
      relation: "new_related",
      query: "mont",
      carry: ["priceMax"],
    });
    expect(grounded.carry).toBeUndefined();
  });

  it("iPhone 15 -> 'buna uygun şarj cihazı': the product reference stays in the query, phone filters do not", () => {
    const { merged } = run(IPHONE, "buna uygun şarj cihazı", {
      relation: "new_related",
      query: "iphone 15 şarj cihazı",
    });
    expect(merged).toEqual(emptyIntent("iphone 15 şarj cihazı"));
    expect(merged?.brand).toBeNull();
    expect(merged?.attributes).toEqual({});
    // Uyumluluk verisi yok: model yönergesi kesin iddiayı yasaklar.
    expect(CHAT_INSTRUCTIONS).toMatch(/uyumlu.*iddia/s);
  });

  it("Nike ayakkabı -> Adidas ayakkabı: the explicit new brand overrides the old one", () => {
    const { merged } = run(NIKE_SHOES, "adidas olsun", { brand: "Adidas" });
    expect(merged).toMatchObject({ brand: "Adidas", query: "nike ayakkabı", priceMax: 5000 });
  });

  it("an explicit new value beats a carried old one", () => {
    const { merged } = run(NIKE_SHOES, "aynı bütçeyle ama en fazla 3000 TL mont", {
      relation: "new_related",
      query: "mont",
      carry: ["priceMax"],
      priceMax: 3000,
    });
    expect(merged?.priceMax).toBe(3000);
  });

  it("Samsung telefon -> Samsung tablet: the Samsung stated in the new message applies", () => {
    const { merged } = run(SAMSUNG_PHONE, "samsung tablet", {
      relation: "new_independent",
      query: "samsung tablet",
      brand: "Samsung",
    });
    expect(merged).toMatchObject({ brand: "Samsung", priceMax: null, sort: null });
  });

  it("a generic 'aynı filtrelerle' supports every filled field", () => {
    const { grounded } = run(NIKE_SHOES, "aynı filtrelerle mont", {
      relation: "new_related",
      query: "mont",
      carry: ["brand", "priceMax", "colors"],
    });
    expect(grounded.carry).toEqual(["brand", "priceMax", "colors"]);
  });

  it("carry is ignored unless relation is new_related", () => {
    const { grounded } = run(NIKE_SHOES, "aynı bütçeyle mont", {
      relation: "new_independent",
      query: "mont",
      carry: ["priceMax"],
    });
    expect(grounded.carry).toBeUndefined();
  });

  it("new_related without any previous intent behaves as an independent first search", () => {
    const { grounded, merged } = run(null, "aynı bütçeyle mont", {
      relation: "new_related",
      query: "mont",
      carry: ["priceMax"],
    });
    expect(grounded.relation).toBeUndefined();
    expect(merged).toEqual(emptyIntent("mont"));
  });
});

describe("scenario: iPhone 15 -> 256 GB -> masa lambası -> şarjlı -> önceki telefonlara dön", () => {
  it("walks the whole conversation through the server pipeline", () => {
    // 1) iPhone 15
    const first = mergeSearchIntent(null, patch({ query: "iphone 15", category: "telefon" }));
    expect(first).toMatchObject({ query: "iphone 15" });
    // 2) 256 GB: daraltma
    const second = run(first, "256 GB olanlar", {
      relation: "refine",
      attributes: { storage: "256 GB" },
    }).merged;
    expect(second).toMatchObject({ query: "iphone 15", attributes: { storage: "256 GB" } });
    // 3) masa lambası: bagimsiz
    const lamp = run(second, "masa lambası", {
      relation: "new_independent",
      query: "masa lambası",
    }).merged;
    expect(lamp).toEqual(emptyIntent("masa lambası"));
    // 4) şarjlı: daraltma
    const charged = run(lamp, "şarjlı olanlar", {
      relation: "refine",
      query: "şarjlı masa lambası",
    }).merged;
    expect(charged).toMatchObject({ query: "şarjlı masa lambası", attributes: {} });
    // 5) önceki telefonlara dön: gecmis telefon niyeti modele baglam olur
    const history = [first, second, lamp, charged];
    const previous = previousTopicIntents(history, charged);
    expect(previous).toHaveLength(1);
    expect(previous[0]).toMatchObject({ query: "iphone 15", attributes: { storage: "256 GB" } });
    const request: InterpretRequest = {
      ...text("önceki telefonlara dön"),
      currentIntent: charged,
      previousIntents: previous,
      pendingQuestion: null,
      clarifyCount: 0,
    };
    expect(JSON.parse(buildChatInput(request)).previous_intents).toEqual(previous);
    // Model, previous_intents'ten acik yama dondurur; sunucu onu aynen birlestirir.
    const groundedBack = groundPatch(
      patch({
        relation: "new_independent",
        query: "iphone 15",
        category: "telefon",
        attributes: { storage: "256 GB" },
      }),
      request,
    );
    expect(mergeSearchIntent(charged, groundedBack)).toMatchObject({
      query: "iphone 15",
      attributes: { storage: "256 GB" },
      brand: null,
    });
    // Donus ipucu yoksa onceki niyetten deger kabul edilmez (modelin uydurmasi).
    const noCue = groundPatch(
      patch({ relation: "new_independent", query: "tablet", attributes: { storage: "256 GB" } }),
      { ...request, ...text("tablet") },
    );
    expect(noCue.attributes).toBeUndefined();
    // Onceki niyetlerde olmayan deger donus isteginde de kabul edilmez.
    const invented = groundPatch(
      patch({ relation: "new_independent", query: "iphone 15", attributes: { storage: "512 GB" } }),
      request,
    );
    expect(invented.attributes).toBeUndefined();
  });

  it("previousTopicIntents collapses versions of one topic and skips the current one", () => {
    const a = emptyIntent("iphone 15");
    const b = emptyIntent("iphone 15 256 gb");
    const lamp = emptyIntent("masa lambası");
    expect(previousTopicIntents([a, b, lamp, null], lamp)).toEqual([b]);
    expect(previousTopicIntents([], lamp)).toEqual([]);
    expect(
      previousTopicIntents([a, lamp, emptyIntent("kulaklık")], emptyIntent("tablet"), 2),
    ).toEqual([emptyIntent("kulaklık"), lamp]);
  });

  it("buildChatInput omits previous_intents when there is none", () => {
    const request = req("merhaba", null);
    expect(JSON.parse(buildChatInput(request))).not.toHaveProperty("previous_intents");
  });
});

describe("contract: relation and carry parsing and schema", () => {
  const turn = (intent: Record<string, unknown>) =>
    parseModelTurn({
      action: "search",
      message: "tamam",
      question: null,
      intent: { reset: false, query: "mont", remove: [], ...intent },
    });

  it("accepts valid relation/carry", () => {
    const parsed = turn({ relation: "new_related", carry: ["priceMax", "brand", "brand"] });
    expect(parsed.ok && parsed.turn.action === "search" && parsed.turn.intent).toMatchObject({
      relation: "new_related",
      carry: ["priceMax", "brand"],
    });
  });

  it("an invalid relation/carry never rejects the turn; the fields are ignored", () => {
    const parsed = turn({ relation: "weird", carry: ["category", "query", "nope", 5] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.turn.action === "search") {
      expect(parsed.turn.intent.relation).toBeUndefined();
      expect(parsed.turn.intent.carry).toBeUndefined();
    }
    expect(turn({ relation: null, carry: null }).ok).toBe(true);
    expect(turn({ carry: "priceMax" }).ok).toBe(true);
  });

  it("old model output without the fields still parses (backward compatible)", () => {
    expect(turn({}).ok).toBe(true);
  });
});

function stub(intent: Record<string, unknown>) {
  return {
    modelVersion: "m",
    interpret: async () => ({
      value: { action: "search", message: "tamam", question: null, intent },
      usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 },
      modelVersion: "m",
    }),
  };
}

describe("interpretTurn end to end (stub model)", () => {
  it("applies grounding to a model relation/carry output", async () => {
    const outcome = await interpretTurn(
      stub({
        reset: false,
        clear: false,
        query: "mont",
        remove: [],
        relation: "new_related",
        carry: ["priceMax", "brand"],
      }),
      req("aynı bütçeyle mont", NIKE_SHOES),
    );
    expect(outcome).toMatchObject({ kind: "turn", source: "model" });
    if (outcome.kind !== "turn" || outcome.turn.action !== "search") throw new Error("search");
    expect(outcome.turn.intent.carry).toEqual(["priceMax"]);
    expect(mergeSearchIntent(NIKE_SHOES, outcome.turn.intent)).toMatchObject({
      query: "mont",
      priceMax: 5000,
      brand: null,
    });
  });

  it("a model without relation keeps the decision-0074 behavior", async () => {
    const outcome = await interpretTurn(
      stub({ reset: false, clear: false, category: "mont", remove: [] }),
      req("mont", NIKE_SHOES),
    );
    if (outcome.kind !== "turn" || outcome.turn.action !== "search") throw new Error("search");
    expect(mergeSearchIntent(NIKE_SHOES, outcome.turn.intent)).toMatchObject({
      brand: "Nike",
      priceMax: 5000,
    });
  });
});

describe("fallback path (no model)", () => {
  const optionRequest = (value: string, label: string): InterpretRequest => ({
    messages: [
      { role: "user", kind: "text", text: "mont" },
      { role: "assistant", kind: "clarify", text: "Önceki tercihlerini koruyayım mı?" },
      { role: "user", kind: "option", text: label },
    ],
    currentIntent: NIKE_SHOES,
    pendingQuestion: { id: "carry_filters", title: "Koruyayım mı?" },
    clarifyCount: 1,
    input: { kind: "option", questionId: "carry_filters", value, label },
  });
  const searchPatch = (request: InterpretRequest): SearchIntentPatch => {
    const turn: ModelTurn = fallbackTurn(request);
    if (turn.action !== "search") throw new Error("fallback must search");
    return turn.intent;
  };

  it("'koru' answer carries the filled filters and searches the original message, not the label", () => {
    const p = searchPatch(optionRequest(CARRY_FILTERS_VALUE, "Önceki tercihlerimi koru"));
    expect(p.query).toBe("mont");
    expect(p.relation).toBe("new_related");
    expect(p.carry).toEqual(expect.arrayContaining(["brand", "priceMax", "colors", "size"]));
    const grounded = groundPatch(p, optionRequest(CARRY_FILTERS_VALUE, "Önceki tercihlerimi koru"));
    expect(mergeSearchIntent(NIKE_SHOES, grounded)).toMatchObject({
      query: "mont",
      brand: "Nike",
      priceMax: 5000,
    });
  });

  it("'sıfırdan ara' answer starts a clean search", () => {
    const p = searchPatch(optionRequest(FRESH_SEARCH_VALUE, "Yeni arama"));
    expect(p.relation).toBe("new_independent");
    expect(mergeSearchIntent(NIKE_SHOES, p)).toEqual(emptyIntent("mont"));
  });

  it("without a relation answer the fallback keeps the legacy refine behavior and no accumulation", () => {
    const p = searchPatch({
      ...req("256 GB olanlar", { ...emptyIntent("iphone 15") }),
    });
    expect(p.relation).toBeUndefined();
    expect(p.query).toBe("iphone 15 256 gb");
    const again = searchPatch(req("256 GB olanlar", emptyIntent("iphone 15 256 gb")));
    expect(again.query).toBe("iphone 15 256 gb");
  });

  it("an invalid model relation falls back to the legacy contract", async () => {
    const outcome = await interpretTurn(
      stub({
        reset: false,
        clear: false,
        query: "mont",
        remove: [],
        relation: "bogus",
        carry: ["priceMax"],
      }),
      req("mont", NIKE_SHOES),
    );
    if (outcome.kind !== "turn" || outcome.turn.action !== "search") throw new Error("search");
    expect(outcome.turn.intent.relation).toBeUndefined();
    expect(outcome.turn.intent.carry).toBeUndefined();
  });
});

describe("review fixes (decision 0199)", () => {
  it("short values are matched as words, not substrings: size M is not 'mont'", () => {
    const withSize: SearchIntent = { ...NIKE_SHOES, size: "M", brand: "Mi" };
    const { grounded } = run(withSize, "mont göster", {
      relation: "new_related",
      query: "mont",
      carry: ["size", "brand"],
    });
    expect(grounded.carry).toBeUndefined();
    // ama sozcuk olarak gecerse desteklenir
    const ok = run(withSize, "beden M mont", {
      relation: "new_related",
      query: "mont",
      carry: ["size"],
    });
    expect(ok.grounded.carry).toEqual(["size"]);
  });

  it("a supported budget carries the whole range", () => {
    const ranged = { ...NIKE_SHOES, priceMin: 2000, priceMax: 5000 };
    const { merged } = run(ranged, "aynı bütçeyle mont", {
      relation: "new_related",
      query: "mont",
      carry: ["priceMax"],
    });
    expect(merged).toMatchObject({ priceMin: 2000, priceMax: 5000 });
  });

  it("'en az 8 gb' is not a price, but 'en az 20000 tl' is (fallback)", () => {
    const refine = (value: string) => {
      const p = fallbackTurn(req(value, emptyIntent("laptop")));
      if (p.action !== "search") throw new Error("search");
      return p.intent;
    };
    expect(refine("en az 8 gb ram olsun")).toMatchObject({ query: "laptop en az 8 gb ram" });
    expect(refine("en az 8 gb ram olsun").priceMin).toBeUndefined();
    expect(refine("en az 20000 tl olsun")).toMatchObject({ priceMin: 20000, query: "laptop" });
  });

  it("previous topics: a same-brand different product is still a different topic", () => {
    const phone: SearchIntent = { ...emptyIntent("samsung telefon"), brand: "Samsung" };
    const tablet: SearchIntent = { ...emptyIntent("samsung tablet"), brand: "Samsung" };
    expect(previousTopicIntents([phone, tablet], tablet)).toEqual([phone]);
  });

  it("blocked text in previous intents never reaches the model", async () => {
    let seen = "";
    const spy = {
      modelVersion: "m",
      interpret: async (r: InterpretRequest) => {
        seen = buildChatInput(r);
        return {
          value: {
            action: "search",
            message: "tamam",
            question: null,
            intent: { reset: false, clear: false, query: "ayakkabı", remove: [] },
          },
          usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 },
          modelVersion: "m",
        };
      },
    };
    await interpretTurn(spy, {
      ...req("siyah olsun", emptyIntent("ayakkabı")),
      previousIntents: [emptyIntent("hamile pantolonu"), emptyIntent("kulaklık")],
    });
    expect(seen).toContain("kulaklık");
    expect(seen).not.toContain("hamile");
  });
});

describe("fallback: existing category lexicon as a safe domain signal", () => {
  const categories: Record<string, string> = {
    telefon: "elektronik/telefon/cep-telefonu",
    "samsung telefon": "elektronik/telefon/cep-telefonu",
    "masa lambası": "ev-yasam/aydinlatma/masa-lambasi",
    mont: "moda/giyim/mont",
    "nike ayakkabı": "moda/ayakkabi/spor",
    "şarj cihazı": "elektronik/aksesuar/sarj",
  };
  const categoryOf = (value: string) => categories[value] ?? null;
  const fb = (value: string, current: SearchIntent) => {
    const turn = fallbackTurn({ ...req(value, current), categoryOf });
    if (turn.action !== "search") throw new Error("search");
    return turn.intent;
  };

  it("a different main domain -> independent search without the old filters", () => {
    const p = fb("masa lambası", SAMSUNG_PHONE);
    expect(p.relation).toBe("new_independent");
    expect(p.query).toBe("masa lambası");
    expect(mergeSearchIntent(SAMSUNG_PHONE, p)).toEqual(emptyIntent("masa lambası"));
  });

  it("explicit values in the new message survive the clean start", () => {
    const merged = mergeSearchIntent(SAMSUNG_PHONE, fb("masa lambası 800 tl altı", SAMSUNG_PHONE));
    expect(merged).toMatchObject({ query: "masa lambası", priceMax: 800, brand: null, sort: null });
  });

  it("same domain (ayakkabı -> mont) keeps the legacy refine behavior", () => {
    const p = fb("mont", NIKE_SHOES);
    expect(p.relation).toBeUndefined();
    expect(mergeSearchIntent(NIKE_SHOES, p)).toMatchObject({ brand: "Nike", priceMax: 5000 });
  });

  it("unresolved text ('256 gb', 'şarjlı') never clears anything", () => {
    expect(fb("256 GB olanlar", SAMSUNG_PHONE).relation).toBeUndefined();
    expect(fb("şarjlı olanlar", SAMSUNG_PHONE).relation).toBeUndefined();
  });

  it("without a lexicon the fallback never guesses", () => {
    const turn = fallbackTurn(req("masa lambası", SAMSUNG_PHONE));
    if (turn.action !== "search") throw new Error("search");
    expect(turn.intent.relation).toBeUndefined();
  });
});

describe("real-model findings replayed offline (decision 0199)", () => {
  // Gercek Gemini ciktilari (gemini-3.1-flash-lite, 15 Kasim): model eski butceyi `carry` yerine
  // yamaya acik deger olarak yazip dogrulamayi atlatiyordu.
  it("scenario 3: a restated old budget is not carried, an explicit color is", () => {
    const { merged } = run(BLACK, "siyah mont da göster", {
      relation: "new_related",
      query: "siyah mont",
      category: "mont",
      colors: ["siyah"],
      priceMax: 3000,
      carry: ["priceMax"],
    });
    expect(merged).toMatchObject({ query: "siyah mont", colors: ["siyah"], priceMax: null });
  });

  it("scenario 7: Samsung stated in the message applies, the restated old budget does not", () => {
    const { merged } = run(SAMSUNG_PHONE, "samsung tablet", {
      relation: "new_related",
      query: "samsung tablet",
      category: "tablet",
      brand: "Samsung",
      priceMax: 15000,
      carry: ["priceMax"],
    });
    expect(merged).toMatchObject({ brand: "Samsung", priceMax: null, sort: null });
  });

  it("scenario 4 still carries when the user says 'aynı bütçeyle', even if the model restates it", () => {
    const { merged } = run(BUDGET, "aynı bütçeyle mont", {
      relation: "new_related",
      query: "mont",
      priceMax: 5000,
      carry: ["priceMax"],
    });
    expect(merged?.priceMax).toBe(5000);
  });

  it("a number the user typed himself is not dropped even if it equals the old one", () => {
    const { merged } = run(BUDGET, "5000 TL altı mont", {
      relation: "new_related",
      query: "mont",
      priceMax: 5000,
    });
    expect(merged?.priceMax).toBe(5000);
  });

  it("a genuinely new value is kept; restated attributes are dropped on a new topic", () => {
    const { merged } = run(IPHONE, "gri tablet 20000 tl altı", {
      relation: "new_independent",
      query: "tablet",
      priceMax: 20000,
      attributes: { storage: "256 GB", color: "gri" },
    });
    expect(merged).toMatchObject({ priceMax: 20000, attributes: { color: "gri" } });
    expect(merged?.attributes).not.toHaveProperty("storage");
  });

  it("refine keeps restated values (decision 0074)", () => {
    const { merged } = run(NIKE_SHOES, "adidas ayakkabı olsun", {
      relation: "refine",
      brand: "Adidas",
      colors: ["siyah"],
      priceMax: 5000,
    });
    expect(merged).toMatchObject({ brand: "Adidas", colors: ["siyah"], priceMax: 5000 });
  });

  it("scenario 5: a compatibility claim in the model message is replaced by an honest one", async () => {
    const outcome = await interpretTurn(
      {
        modelVersion: "m",
        interpret: async () => ({
          value: {
            action: "search",
            message: "iPhone 15 ile uyumlu şarj cihazlarını aşağıda listeliyorum.",
            question: null,
            intent: {
              reset: false,
              clear: false,
              query: "iphone 15 şarj cihazı",
              remove: [],
              relation: "new_related",
            },
          },
          usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 },
          modelVersion: "m",
        }),
      },
      req("buna uygun şarj cihazı", IPHONE),
    );
    if (outcome.kind !== "turn" || outcome.turn.action !== "search") throw new Error("search");
    expect(outcome.turn.message).not.toMatch(/ile uyumlu/i);
    expect(outcome.turn.message).toContain("kontrol etmeni öneririm");
    expect(outcome.turn.message).toContain("iphone 15 şarj cihazı");
    expect(neutralizeCompatibilityClaim("Şarj cihazlarını aşağıda arıyorum.", "x")).toBe(
      "Şarj cihazlarını aşağıda arıyorum.",
    );
    expect(neutralizeCompatibilityClaim("bütçene uygun modeller", "x")).toBe(
      "bütçene uygun modeller",
    );
  });
});

describe("every new exact filter must be backed by the user's words (decision 0199)", () => {
  it("an invented brand/color/size/attribute on a new topic is dropped", () => {
    const { merged } = run(SAMSUNG_PHONE, "masa lambası", {
      relation: "new_independent",
      query: "masa lambası",
      brand: "Philips",
      colors: ["beyaz"],
      size: "L",
      attributes: { power: "10 W" },
      excludeBrands: ["Xiaomi"],
      sort: "cheapest",
    });
    expect(merged).toEqual(emptyIntent("masa lambası"));
  });

  it("values the user actually wrote are kept (suffixes and unit spacing tolerated)", () => {
    const { merged } = run(SAMSUNG_PHONE, "beyaz Philips masa lambası 10W olsun, Xiaomi olmasın", {
      relation: "new_independent",
      query: "masa lambası",
      brand: "Philips",
      colors: ["beyaz"],
      attributes: { power: "10 W" },
      excludeBrands: ["Xiaomi"],
    });
    expect(merged).toMatchObject({
      brand: "Philips",
      colors: ["beyaz"],
      attributes: { power: "10 W" },
      excludeBrands: ["Xiaomi"],
    });
  });

  it("only the unsupported part of a list is dropped", () => {
    const { merged } = run(NIKE_SHOES, "siyah mont", {
      relation: "new_related",
      query: "siyah mont",
      colors: ["siyah", "kırmızı"],
    });
    expect(merged?.colors).toEqual(["siyah"]);
  });

  it("a made-up price is dropped, a typed one is kept", () => {
    expect(
      run(SAMSUNG_PHONE, "masa lambası", {
        relation: "new_independent",
        query: "masa lambası",
        priceMax: 800,
      }).merged?.priceMax,
    ).toBeNull();
    expect(
      run(SAMSUNG_PHONE, "masa lambası 800 tl altı", {
        relation: "new_independent",
        query: "masa lambası",
        priceMax: 800,
      }).merged?.priceMax,
    ).toBe(800);
  });

  it("a different brand the user did not write is dropped even though it differs from the old one", () => {
    const { merged } = run(NIKE_SHOES, "mont", {
      relation: "new_related",
      query: "mont",
      brand: "Adidas",
    });
    expect(merged?.brand).toBeNull();
  });

  it("refine and legacy patches are NOT subject to this check (decision 0074)", () => {
    expect(run(NIKE_SHOES, "mont", { brand: "Adidas" }).merged?.brand).toBe("Adidas");
    expect(
      run(NIKE_SHOES, "mont", { relation: "refine", colors: ["kırmızı"] }).merged?.colors,
    ).toEqual(["kırmızı"]);
    expect(
      run(NIKE_SHOES, "mont", { reset: true, query: "mont", brand: "Adidas" }).merged?.brand,
    ).toBe("Adidas");
  });

  it("an option answer is judged against the option and the message that raised the question", () => {
    const request: InterpretRequest = {
      messages: [
        { role: "user", kind: "text", text: "siyah mont" },
        { role: "assistant", kind: "clarify", text: "Koruyayım mı?" },
        { role: "user", kind: "option", text: "Önceki tercihlerimi koru" },
      ],
      currentIntent: NIKE_SHOES,
      pendingQuestion: { id: "carry_filters", title: "?" },
      clarifyCount: 1,
      input: {
        kind: "option",
        questionId: "carry_filters",
        value: CARRY_FILTERS_VALUE,
        label: "Önceki tercihlerimi koru",
      },
    };
    const grounded = groundPatch(
      patch({
        relation: "new_related",
        query: "siyah mont",
        colors: ["siyah"],
        brand: "Puma",
        carry: ["brand", "priceMax"],
      }),
      request,
    );
    expect(grounded.colors).toEqual(["siyah"]);
    expect(grounded.brand).toBeUndefined();
    expect(grounded.carry).toEqual(expect.arrayContaining(["brand", "priceMax"]));
  });
});

describe("new topic without a usable query never leaks the old filters (decision 0199)", () => {
  const modelOf = (intent: Record<string, unknown>) => ({
    modelVersion: "m",
    interpret: async () => ({
      value: { action: "search", message: "tamam", question: null, intent },
      usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 },
      modelVersion: "m",
    }),
  });

  for (const relation of ["new_independent", "new_related"] as const) {
    it(`${relation} without query -> clean search from the user's own words`, async () => {
      const outcome = await interpretTurn(
        modelOf({ reset: false, clear: false, remove: [], relation, carry: ["priceMax"] }),
        req("masa lambası", SAMSUNG_PHONE),
      );
      expect(outcome).toMatchObject({
        kind: "turn",
        source: "fallback",
        fallbackReason: "no_query",
      });
      if (outcome.kind !== "turn" || outcome.turn.action !== "search") throw new Error("search");
      expect(mergeSearchIntent(SAMSUNG_PHONE, outcome.turn.intent)).toEqual(
        emptyIntent("masa lambası"),
      );
    });
  }

  it("a legacy reset without query also starts clean", async () => {
    const outcome = await interpretTurn(
      modelOf({ reset: true, clear: false, remove: [] }),
      req("masa lambası", SAMSUNG_PHONE),
    );
    if (outcome.kind !== "turn" || outcome.turn.action !== "search") throw new Error("search");
    expect(mergeSearchIntent(SAMSUNG_PHONE, outcome.turn.intent)).toEqual(
      emptyIntent("masa lambası"),
    );
  });

  it("a plain refine without query keeps the decision-0074 fallback (appends, keeps filters)", async () => {
    const outcome = await interpretTurn(
      modelOf({ reset: false, clear: false, remove: [] }),
      req("siyah olsun", NIKE_SHOES),
    );
    if (outcome.kind !== "turn" || outcome.turn.action !== "search") throw new Error("search");
    expect(mergeSearchIntent(NIKE_SHOES, outcome.turn.intent)).toMatchObject({
      brand: "Nike",
      priceMax: 5000,
    });
  });

  it("fallbackTurnAfterNewTopic keeps prices the user typed and cleans filler", () => {
    const turn = fallbackTurnAfterNewTopic(
      req("masa lambası 800 tl altı olsun", SAMSUNG_PHONE),
      patch({ relation: "new_independent" }),
    );
    if (turn.action !== "search") throw new Error("search");
    expect(mergeSearchIntent(SAMSUNG_PHONE, turn.intent)).toMatchObject({
      query: "masa lambası",
      priceMax: 800,
      brand: null,
    });
  });
});

describe("same-category 'new topic' is a refinement (real-model finding, decision 0199)", () => {
  it("scenario 6 replay: Nike -> Adidas flagged new_related keeps the old color and budget", () => {
    const { grounded, merged } = run(NIKE_SHOES, "adidas ayakkabı olsun", {
      relation: "new_related",
      query: "adidas ayakkabı",
      category: "ayakkabı",
      brand: "Adidas",
      priceMax: 5000,
      carry: ["priceMax"],
    });
    expect(grounded.relation).toBe("refine");
    expect(grounded.carry).toBeUndefined();
    expect(merged).toMatchObject({
      brand: "Adidas",
      colors: ["siyah"],
      priceMax: 5000,
      size: "42",
    });
  });

  it("category comparison ignores case; a different category stays a new topic", () => {
    const same = run(NIKE_SHOES, "Ayakkabı", {
      relation: "new_independent",
      query: "ayakkabı",
      category: "Ayakkabı",
    });
    expect(same.grounded.relation).toBe("refine");
    const other = run(NIKE_SHOES, "mont", {
      relation: "new_independent",
      query: "mont",
      category: "mont",
    });
    expect(other.grounded.relation).toBe("new_independent");
    expect(other.merged).toEqual({ ...emptyIntent("mont"), category: "mont" });
  });

  it("an explicit clear/reset is never downgraded", () => {
    const { merged } = run(NIKE_SHOES, "ayakkabı", {
      relation: "new_independent",
      reset: true,
      query: "ayakkabı",
      category: "ayakkabı",
    });
    expect(merged).toEqual({ ...emptyIntent("ayakkabı"), category: "ayakkabı" });
  });
});
