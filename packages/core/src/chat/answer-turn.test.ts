/**
 * Karar 0203: `answer` eylemi `interpretTurn` hattında. Model sahte; sunucu doğrulaması,
 * gerçeksiz tur reddi, süzgeç ve şema seçimi.
 */
import { describe, expect, it } from "vitest";
import type { ResultFact } from "./answer.ts";
import { buildModelTurnSchema, parseModelTurn } from "./contract.ts";
import { emptyIntent } from "./intent.ts";
import {
  buildChatInput,
  CHAT_INSTRUCTIONS,
  type InterpretRequest,
  interpretTurn,
} from "./interpreter.ts";

const FACTS: ResultFact[] = [
  {
    id: "p1",
    title: "Philips Hue Masa Lambası 9 W",
    brand: "Philips",
    store: "Hepsiburada",
    price_try: 1299,
    offer_count: 3,
  },
  {
    id: "p2",
    title: "Xiaomi LED Masa Lambası",
    brand: "Xiaomi",
    store: "Trendyol",
    price_try: 799,
    offer_count: 1,
  },
];

const request = (over: Partial<InterpretRequest> = {}): InterpretRequest => ({
  messages: [{ role: "user", kind: "text", text: "hangisi daha uygun?" }],
  currentIntent: emptyIntent("masa lambası"),
  pendingQuestion: null,
  clarifyCount: 0,
  input: { kind: "text", text: "hangisi daha uygun?" },
  resultFacts: FACTS,
  ...over,
});

const model = (value: unknown) => ({
  modelVersion: "m",
  interpret: async () => ({
    value,
    usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 },
    modelVersion: "m",
  }),
});

const answerOf = (paragraphs: unknown[], message = "Kısa cevap.") => ({
  action: "answer",
  message,
  question: null,
  intent: null,
  answer: { paragraphs },
});

const GOOD = {
  text: "Xiaomi lambası Trendyol'da 799 TL, Philips Hue ise Hepsiburada'da 1.299 TL fiyatla listeleniyor.",
  evidence: [
    { item: "p2", field: "price", quote: "799" },
    { item: "p1", field: "price", quote: "1299" },
  ],
};

describe("interpretTurn: answer action (decision 0203)", () => {
  it("shows a server-validated answer built from the quoted facts", async () => {
    const outcome = await interpretTurn(model(answerOf([GOOD])), request());
    expect(outcome).toMatchObject({ kind: "turn", source: "model" });
    if (outcome.kind !== "turn" || outcome.turn.action !== "answer") throw new Error("answer");
    expect(outcome.turn.message).toBe(GOOD.text);
    expect(outcome.turn.answer).toMatchObject({
      validated: true,
      rejected: [],
      facts: ["p1", "p2"],
    });
  });

  it("an unverifiable answer is NEVER shown: a model-free factual summary replaces it", async () => {
    const bad = {
      text: "Philips Hue en iyi seçenek ve 12 saat pil ömrü sunuyor, kesinlikle önerilir burada.",
      evidence: [{ item: "p1", field: "brand", quote: "Philips" }],
    };
    const outcome = await interpretTurn(model(answerOf([bad])), request());
    if (outcome.kind !== "turn" || outcome.turn.action !== "answer") throw new Error("answer");
    expect(outcome.turn.message).not.toContain("en iyi");
    expect(outcome.turn.message).not.toContain("pil");
    // 2 üründe olgusal özet de yazılmaz: dürüst "karşılaştıramadım" cümlesi
    expect(outcome.turn.message).toContain("güvenle karşılaştıramadım");
    expect(outcome.turn.answer).toMatchObject({ validated: false });
    expect(outcome.source).toBe("model"); // model çağrıldı; sunum güvenli yedek
  });

  it("with 3+ facts the replacement is the factual price summary", async () => {
    const third: ResultFact = {
      id: "p3",
      title: "Okuma Lambası",
      brand: null,
      store: "Trendyol",
      price_try: 500,
      offer_count: 1,
    };
    const bad = {
      text: "Bu lambalar kesinlikle mükemmel ve kaliteli ürünler olarak görünüyor listede.",
      evidence: [{ item: "p1", field: "brand", quote: "Philips" }],
    };
    const outcome = await interpretTurn(
      model(answerOf([bad])),
      request({ resultFacts: [...FACTS, third] }),
    );
    if (outcome.kind !== "turn" || outcome.turn.action !== "answer") throw new Error("answer");
    expect(outcome.turn.message).toContain("yorumlayamadım");
    expect(outcome.turn.message).toMatch(/500 TL/);
    expect(outcome.turn.message).not.toMatch(/mükemmel|kaliteli/);
  });

  it("without product facts the model may not answer: normal fallback search runs", async () => {
    const outcome = await interpretTurn(
      model(answerOf([GOOD])),
      request({ resultFacts: undefined }),
    );
    expect(outcome).toMatchObject({ kind: "turn", source: "fallback" });
    if (outcome.kind !== "turn") throw new Error("turn");
    expect(outcome.turn.action).toBe("search");
  });

  it("a malformed answer object is rejected, never thrown", async () => {
    for (const answer of [null, "x", [], { paragraphs: "x" }]) {
      const outcome = await interpretTurn(model({ ...answerOf([GOOD]), answer }), request());
      expect(outcome.kind).toBe("turn");
      if (outcome.kind === "turn" && outcome.turn.action === "answer") {
        expect(outcome.turn.answer).toMatchObject({ validated: false });
      }
    }
  });

  it("search and clarify turns are untouched by the new action", async () => {
    const search = await interpretTurn(
      model({
        action: "search",
        message: "Tamam, aşağıda arıyorum.",
        question: null,
        intent: { reset: false, clear: false, remove: [], query: "masa lambası" },
      }),
      request(),
    );
    expect(search).toMatchObject({ kind: "turn", source: "model" });
    if (search.kind === "turn") expect(search.turn.action).toBe("search");
  });

  it("product facts pass the same filter as user text: blocked titles never reach the model", async () => {
    let seen = "";
    const spy = {
      modelVersion: "m",
      interpret: async (r: InterpretRequest) => {
        seen = buildChatInput(r);
        return {
          value: answerOf([GOOD]),
          usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 },
          modelVersion: "m",
        };
      },
    };
    await interpretTurn(
      spy,
      request({
        resultFacts: [
          ...FACTS,
          {
            id: "p3",
            title: "Hamile pantolonu",
            brand: null,
            store: null,
            price_try: 100,
            offer_count: 1,
          },
        ],
      }),
    );
    expect(seen).toContain("Philips Hue");
    expect(seen).not.toContain("Hamile");
  });
});

describe("contract and prompt (decision 0203)", () => {
  it("the answer action exists in the schema ONLY when facts are supplied", () => {
    const plain = buildModelTurnSchema() as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    const withAnswer = buildModelTurnSchema({ answer: true }) as typeof plain;
    expect(plain.properties.action?.enum).toEqual(["clarify", "search"]);
    expect(plain.properties.answer).toBeUndefined();
    expect(withAnswer.properties.action?.enum).toEqual(["clarify", "search", "answer"]);
    expect(withAnswer.properties.answer).toBeDefined();
    expect(withAnswer.required).toContain("answer");
    // nullable: search/clarify turlarinda `answer` null olabilir
    expect((withAnswer.properties.answer as { type: string[] }).type).toContain("null");
  });

  it("parseModelTurn passes an answer through as raw data and refuses non-objects", () => {
    expect(parseModelTurn(answerOf([GOOD]))).toMatchObject({
      ok: true,
      turn: { action: "answer" },
    });
    expect(parseModelTurn({ ...answerOf([GOOD]), answer: null })).toEqual({
      ok: false,
      reason: "bad_intent",
    });
    expect(parseModelTurn({ ...answerOf([GOOD]), message: "https://x.test" }).ok).toBe(false);
  });

  it("the model input carries result_facts only when facts exist; instructions forbid unevidenced claims", () => {
    expect(JSON.parse(buildChatInput(request())).result_facts).toHaveLength(2);
    expect(
      JSON.parse(buildChatInput(request({ resultFacts: undefined }))).result_facts,
    ).toBeUndefined();
    expect(JSON.parse(buildChatInput(request({ resultFacts: [] }))).result_facts).toBeUndefined();
    expect(CHAT_INSTRUCTIONS).toContain('action="answer"');
    expect(CHAT_INSTRUCTIONS).toMatch(/KANITSIZ/);
  });
});
